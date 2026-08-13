import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { ConversationViewProps } from '@glacier/react';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { usePlaylists } from './playlists.tsx';
import { fetchDj, remotePath, trackIdFromPath } from './server.ts';
import type { Track } from './tauri.ts';

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
  /** A run of picks: play it, queue it, or take it into a playlist. */
  | { kind: 'set'; trackIds: number[] }
  /** Steering pills. Tapping one posts it as an ordinary user turn, so the
   *  transcript reads the same whether you tapped or typed. */
  | { kind: 'chips'; options: { label: string; send: string }[] }
  /** The playlist being built, editable until it is saved. */
  | { kind: 'draft'; draftId: string; name: string; trackIds: number[]; saved?: boolean }
  /** What was actually written to the library. Terminal, never edits. */
  | { kind: 'receipt'; playlistId: string; name: string; trackIds: number[] }
  /** The honest states - no server, no library, nothing came back. */
  | { kind: 'notice'; tone: 'info' | 'warn'; text: string };

export interface DjMessage extends KitMessage {
  embed?: DjEmbed;
}

export const DJ_AUTHOR = 'dj';

interface DjChat {
  messages: DjMessage[];
  busy: boolean;
  /** Send a turn as the user. Empty text is ignored. */
  send: (text: string) => void;
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
    text: "I'm the DJ. I know what you play — tell me what you're after and I'll put something on, or we can build a playlist together.",
  },
  {
    id: nextId(),
    authorId: DJ_AUTHOR,
    at: OPENED_AT,
    breaksGroup: true,
    embed: {
      kind: 'chips',
      options: [
        { label: 'Put something on', send: 'Put something on' },
        { label: 'Something mellow', send: 'Something mellow for a rainy morning' },
        { label: 'Late and low', send: 'Something for driving at night' },
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
    (raw: string) => {
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
          text: 'The DJ runs on your server — connect one under Settings → Server and I can dig through your library.',
        });
        return;
      }
      if (tracks.length === 0) {
        say('', {
          kind: 'notice',
          tone: 'info',
          text: 'There is nothing in your library yet. Add some music and I will have something to work with.',
        });
        return;
      }
      // Two turns of context: "slower" means nothing on its own, but it means
      // plenty next to what it is answering.
      const seed = lastAsk.current ? `${lastAsk.current}. ${text}` : text;
      lastAsk.current = text;
      setBusy(true);
      void fetchDj(session, seed, 24)
        .then((reply) => {
          let spoke = false;
          for (const block of reply.blocks) {
            const found = resolve(block.trackIds);
            if (found.length === 0) continue;
            spoke = true;
            say(
              block.say.trim(),
              { kind: 'set', trackIds: found.map((t) => trackIdFromPath(t.path)!) },
            );
          }
          if (!spoke) {
            say('', {
              kind: 'notice',
              tone: 'info',
              text: "I could not find anything for that in what you own. Try a different mood, or an artist you have.",
            });
          }
        })
        .catch((err: unknown) => {
          say('', {
            kind: 'notice',
            tone: 'warn',
            text: err instanceof Error ? err.message : 'The DJ could not answer just then.',
          });
        })
        .finally(() => setBusy(false));
    },
    [append, busy, resolve, say, session, tracks.length],
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
        say(added > 0 ? `Added ${added}. Tell me what to change.` : 'Those are already in it.');
        return;
      }
      const draftId = nextId();
      liveDraft.current = draftId;
      say('Here it is so far. Rename it, drop what you do not want, then save it.', {
        kind: 'draft',
        draftId,
        name: 'New playlist',
        trackIds: [...trackIds],
      });
    },
    [patchDraft, say],
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
      const name = card.name.trim() || 'New playlist';
      const ids = [...card.trackIds];
      if (ids.length === 0) return;
      // Frozen before the write, not after: two live editors for one playlist
      // is how a whole-array write clobbers an edit made somewhere else.
      patchDraft(draftId, (e) => ({ ...e, saved: true }));
      liveDraft.current = null;
      void create(name, ids.map(remotePath))
        .then((playlistId) => {
          say('Filed. It is in your playlists.', {
            kind: 'receipt',
            playlistId,
            name,
            trackIds: ids,
          });
        })
        .catch(() => {
          patchDraft(draftId, (e) => ({ ...e, saved: false }));
          liveDraft.current = draftId;
          say('', { kind: 'notice', tone: 'warn', text: 'That would not save. Try again?' });
        });
    },
    [create, messages, patchDraft, say],
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
