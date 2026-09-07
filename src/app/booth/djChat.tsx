import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { noteDjAsk } from './djAsks.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import type { ConversationViewProps } from '@glacier/react';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { usePlaylists } from '../playlists/playlists.tsx';
import { fetchDj, remotePath, trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The DJ conversation: the transcript, and everything that can happen in it.
 *
 * It lives at the app's root rather than inside the page for one reason - a
 * page unmounts the moment you navigate, and a conversation that forgets itself
 * when you go and look at an artist is not a conversation. The page below is a
 * pure view over this.
 *
 * What the DJ says is prose; what it DOES is a card. Every embed here is built
 * from data this client already trusts - track ids resolved against the synced
 * library, counts computed by us - so an answer is never a claim the model made
 * about the world. The model's whole job is the sentence at the top.
 */

/** The kit does not export ChatMessage, but it exports the props that carry it;
 *  taking the type from there keeps us honest across a kit bump instead of
 *  maintaining a hand-copied duplicate that can drift in silence. */
type KitMessage = ConversationViewProps['messages'][number];

/** What a message can carry besides words. Each is a thing you can act on. */
export type DjEmbed =
  /** A run of picks: play it, queue it, or take it into a playlist. `why`
   *  is the hub's own line per id, for the hold on a row; absent from a
   *  hub that gave none. */
  | { kind: 'set'; trackIds: number[]; why?: Record<number, string> }
  /** Steering pills. Tapping one posts it as an ordinary user turn, so the
   *  transcript reads the same whether you tapped or typed. The pill's word
   *  is a catalogue key - the only chips there are seeded below, before any
   *  provider exists - while `send` is the sentence the hub embeds and stays
   *  in the language the model was tuned on. */
  | { kind: 'chips'; options: { labelKey: string; send: string }[] }
  /** The playlist being built, editable until it is saved. */
  | { kind: 'draft'; draftId: string; name: string; trackIds: number[]; saved?: boolean }
  /** What was actually written to the library. Terminal, never edits. */
  | { kind: 'receipt'; playlistId: string; name: string; trackIds: number[] }
  /** The honest states - no server, no library, nothing came back. */
  | { kind: 'notice'; tone: 'info' | 'warn'; text: string };

export interface DjMessage extends KitMessage {
  embed?: DjEmbed;
  /** Carried instead of `text` by anything built outside a render - which is
   *  only the opening below, and only because a greeting composed at import
   *  time would still be in the boot language after the picker moved. The
   *  view resolves it; everything the DJ says later is already a live
   *  string. */
  textKey?: string;
}

export const DJ_AUTHOR = 'dj';

interface DjChat {
  messages: DjMessage[];
  busy: boolean;
  /** Send a turn as the user. Empty text is ignored. A station chip sends
   *  its seed on its own - not prefixed with the last ask - and carries the
   *  station's literal constraint when it has one. */
  send: (text: string, opts?: { station?: boolean; filter?: string }) => void;
  /** Take a set's tracks into the working draft, creating one if needed. */
  toDraft: (trackIds: number[]) => void;
  renameDraft: (draftId: string, name: string) => void;
  removeFromDraft: (draftId: string, trackId: number) => void;
  /** Commit a draft to a real playlist and answer with a receipt. */
  saveDraft: (draftId: string) => void;
  /** Resolve ids to library tracks, in the order given. */
  resolve: (trackIds: number[]) => Track[];
  clear: () => void;
}

const DjChatContext = createContext<DjChat | null>(null);

/** Ids are unique per session; the kit groups and anchors on them, so a
 *  duplicate would make two messages fight over one place in the list. */
let seq = 0;
const nextId = () => `dj-${(seq += 1)}`;

/** Stamped once, when the module loads, rather than 0 - the kit draws a day
 *  header off `at`, and an epoch zero puts "Dec 31, 1969" above the greeting. */
const OPENED_AT = Date.now();

const OPENING: DjMessage[] = [
  {
    id: nextId(),
    authorId: DJ_AUTHOR,
    at: OPENED_AT,
    textKey: 'booth.chatOpening',
  },
  {
    id: nextId(),
    authorId: DJ_AUTHOR,
    at: OPENED_AT,
    breaksGroup: true,
    embed: {
      kind: 'chips',
      options: [
        { labelKey: 'booth.chatChipStart', send: 'Put something on' },
        { labelKey: 'booth.chatChipMellow', send: 'Something mellow for a rainy morning' },
        { labelKey: 'booth.chatChipNight', send: 'Something for driving at night' },
      ],
    },
  },
];

export function DjChatProvider({
  children,
  onPlay,
}: {
  children: ReactNode;
  /** How the cards actually start music - the app's own playFrom. */
  onPlay: (track: Track, queue: Track[]) => void;
}) {
  const t = useT();
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const { create } = usePlaylists();
  const [messages, setMessages] = useState<DjMessage[]>(OPENING);
  const [busy, setBusy] = useState(false);
  // The last thing asked for, so a steering turn ("slower") still carries the
  // subject with it - two words embed to almost nothing on their own.
  const lastAsk = useRef('');

  const byId = useMemo(() => {
    const map = new Map<number, Track>();
    for (const t of tracks) {
      const id = trackIdFromPath(t.path);
      if (id != null) map.set(id, t);
    }
    return map;
  }, [tracks]);

  const resolve = useCallback(
    (ids: number[]) => ids.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined),
    [byId],
  );

  const append = useCallback((...next: DjMessage[]) => {
    setMessages((prev) => [...prev, ...next]);
  }, []);

  const say = useCallback(
    (text: string, embed?: DjEmbed) => {
      append({
        id: nextId(),
        authorId: DJ_AUTHOR,
        at: Date.now(),
        text: text || undefined,
        embed,
        // A card is never swallowed into a run of the DJ's prose.
        breaksGroup: embed !== undefined,
      });
    },
    [append],
  );

  const send = useCallback(
    (raw: string, opts?: { station?: boolean; filter?: string }) => {
      const text = raw.trim();
      if (!text || busy) return;
      append({
        id: nextId(),
        authorId: session?.username ?? 'me',
        at: Date.now(),
        text,
        status: 'sent',
      });
      if (!session) {
        say('', {
          kind: 'notice',
          tone: 'warn',
          text: t('booth.needServer'),
        });
        return;
      }
      if (tracks.length === 0) {
        say('', {
          kind: 'notice',
          tone: 'info',
          text: t('booth.needLibrary'),
        });
        return;
      }
      // Two turns of context: "slower" means nothing on its own, but it means
      // plenty next to what it is answering. A station is a fresh start - its
      // seed is a measured description of a sound, and yesterday's ask glued
      // in front of it only muddied what the server embeds.
      const seed = lastAsk.current && !opts?.station ? `${lastAsk.current}. ${text}` : text;
      lastAsk.current = text;
      // The listener's OWN words, remembered for the deck's "recent asks" -
      // a station tap is the hub's sentence, not theirs, and is not kept.
      if (!opts?.station) noteDjAsk(text);
      setBusy(true);
      void fetchDj(session, seed, 24, { filter: opts?.filter })
        .then((reply) => {
          let spoke = false;
          for (const block of reply.blocks) {
            const found = resolve(block.trackIds);
            if (found.length === 0) continue;
            spoke = true;
            const ids = found.map((t) => trackIdFromPath(t.path)!);
            const why: Record<number, string> = {};
            for (const id of ids) {
              const line = reply.why?.[String(id)];
              if (line) why[id] = line;
            }
            say(block.say.trim(), {
              kind: 'set',
              trackIds: ids,
              ...(Object.keys(why).length > 0 ? { why } : {}),
            });
          }
          if (!spoke) {
            say('', {
              kind: 'notice',
              tone: 'info',
              text: t('booth.noMatches'),
            });
          }
        })
        .catch((err: unknown) => {
          say('', {
            kind: 'notice',
            tone: 'warn',
            text: err instanceof Error ? err.message : t('booth.couldNotAnswer'),
          });
        })
        .finally(() => setBusy(false));
    },
    [append, busy, resolve, say, session, t, tracks.length],
  );

  // --- the draft ----------------------------------------------------------

  /** The draft under the hand: only the newest one is live, so two cards can
   *  never disagree about what the playlist contains. */
  const liveDraft = useRef<string | null>(null);

  const patchDraft = useCallback(
    (draftId: string, patch: (embed: Extract<DjEmbed, { kind: 'draft' }>) => DjEmbed) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.embed?.kind === 'draft' && m.embed.draftId === draftId
            ? { ...m, embed: patch(m.embed) }
            : m,
        ),
      );
    },
    [],
  );

  const toDraft = useCallback(
    (trackIds: number[]) => {
      const open = liveDraft.current;
      if (open) {
        let added = 0;
        patchDraft(open, (embed) => {
          if (embed.saved) return embed;
          const merged = [...embed.trackIds];
          for (const id of trackIds) if (!merged.includes(id)) merged.push(id);
          added = merged.length - embed.trackIds.length;
          return { ...embed, trackIds: merged };
        });
        // The count is ours, counted here - the DJ never quotes a number it
        // did not work out itself.
        say(added > 0 ? t('booth.draftAdded', { count: added }) : t('booth.draftAlreadyIn'));
        return;
      }
      const draftId = nextId();
      liveDraft.current = draftId;
      say(t('booth.draftIntro'), {
        kind: 'draft',
        draftId,
        // The name the listener will see in the field, and the one that goes
        // to the library if they never touch it - so it is theirs, in their
        // language, not the app's boot language.
        name: t('library.newPlaylist'),
        trackIds: [...trackIds],
      });
    },
    [patchDraft, say, t],
  );

  const renameDraft = useCallback(
    (draftId: string, name: string) => patchDraft(draftId, (e) => ({ ...e, name })),
    [patchDraft],
  );

  const removeFromDraft = useCallback(
    (draftId: string, trackId: number) =>
      patchDraft(draftId, (e) => ({ ...e, trackIds: e.trackIds.filter((id) => id !== trackId) })),
    [patchDraft],
  );

  const saveDraft = useCallback(
    (draftId: string) => {
      const card = messages.find(
        (m) => m.embed?.kind === 'draft' && m.embed.draftId === draftId,
      )?.embed;
      if (!card || card.kind !== 'draft' || card.saved) return;
      const name = card.name.trim() || t('library.newPlaylist');
      const ids = [...card.trackIds];
      if (ids.length === 0) return;
      // Frozen before the write, not after: two live editors for one playlist
      // is how a whole-array write clobbers an edit made somewhere else.
      patchDraft(draftId, (e) => ({ ...e, saved: true }));
      liveDraft.current = null;
      void create(name, ids.map((id) => remotePath(id)))
        .then((playlistId) => {
          say(t('booth.draftSaved'), {
            kind: 'receipt',
            playlistId,
            name,
            trackIds: ids,
          });
        })
        .catch(() => {
          patchDraft(draftId, (e) => ({ ...e, saved: false }));
          liveDraft.current = draftId;
          say('', { kind: 'notice', tone: 'warn', text: t('booth.draftSaveFailed') });
        });
    },
    [create, messages, patchDraft, say, t],
  );

  const clear = useCallback(() => {
    liveDraft.current = null;
    lastAsk.current = '';
    setMessages(OPENING);
  }, []);

  const value = useMemo(
    () => ({ messages, busy, send, toDraft, renameDraft, removeFromDraft, saveDraft, resolve, clear }),
    [messages, busy, send, toDraft, renameDraft, removeFromDraft, saveDraft, resolve, clear],
  );
  // onPlay is handed to the cards through a ref-free context of its own below,
  // so a new playFrom identity each render never re-renders the transcript.
  return (
    <DjChatContext.Provider value={value}>
      <DjPlayContext.Provider value={onPlay}>{children}</DjPlayContext.Provider>
    </DjChatContext.Provider>
  );
}

const DjPlayContext = createContext<((track: Track, queue: Track[]) => void) | null>(null);

export function useDjChat(): DjChat | null {
  return useContext(DjChatContext);
}

export function useDjPlay() {
  return useContext(DjPlayContext);
}
