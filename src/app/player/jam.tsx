import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '@glacier/react';
import { Users } from '@glacier/icons';
import { fireNativeHaptic } from '../core/haptics.ts';
import { openNowPlaying } from '../nav/nowPlayingDoor.ts';
import { armGrooveDeck } from '../nav/grooveDoor.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { ServerError } from '../api/http.ts';
import { syncRegistryFriendsToHub } from '../profile/friendMirror.ts';
import { sayNames } from '../nav/friendPickerDoor.ts';
import { pushJamState, trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';
// Toasts and refusal reasons are BUILT here and handed off, not rendered from
// this file, so they take the non-reactive translator: each is resolved once,
// in the language of the moment it was raised, and never re-renders. Using the
// hook would also put `t` in half a dozen dependency arrays and re-arm a poll
// every time somebody changed language.
import { translate } from '../i18n/LocaleShell.tsx';
import {
  acceptJamInvite as acceptJamInviteApi,
  addToJamQueue,
  controlJam as controlJamApi,
  withdrawFromJamQueue,
  declineJamInvite as declineJamInviteApi,
  endJam as endJamApi,
  fetchJams,
  inviteToJam as inviteToJamApi,
  joinJam as joinJamApi,
  leaveJam as leaveJamApi,
  startJam as startJamApi,
  type Jam,
  type JamBeatReply,
  type JamCommand,
  type JamControlAction,
  type JamInvite,
  type JamPending,
} from '../server.ts';
import type { HearMode } from './deckShared.ts';

/**
 * The groove a listener is in, if any: friends following one host's clock.
 *
 * (Called a JAM in every identifier, route and storage key - the name people
 * read changed to "groove"; the code's did not, because renaming a working
 * wire protocol buys nobody anything and breaks older clients.)
 *
 * This holds the ROOM, not the audio. The host's Player posts where it is
 * (through `hostBeat`); a follower's Player reads `current` and steers itself
 * to match. Keeping the two apart means the deck stays the one thing that
 * drives sound, exactly as it does outside a jam.
 *
 * Polled rather than socketed. A jam is a song at a time - four seconds of
 * drift on a join is inaudible once the follower carries the position forward
 * itself, and a poll cannot leave a room wedged the way a dropped socket can.
 *
 * The pace depends on being IN one. Four seconds is for followers, who ride
 * the host's clock. Outside a room the poll only exists to notice a friend
 * starting a jam - a half-minute lag on that invitation is nothing, and the
 * fast poll from every signed-in device was the single chattiest thing the
 * app did: 21,600 requests a day each, radio held warm, for an event that
 * almost never happens. Hidden (the phone pocketed, the tab backgrounded) it
 * does not poll at all; coming back refreshes at once.
 */
const POLL_IN_JAM_MS = 3000;
/** In a room but hidden (the phone in a pocket, still playing): slower, but
 *  never stopped - the poll is also the member's heartbeat, and a follower
 *  that stops polling stops following. */
const POLL_IN_JAM_HIDDEN_MS = 8000;
const POLL_IDLE_MS = 30_000;
/** How long a host's player may go unheard before the room says so. The
 *  host beats every 2.5 s; forty-five seconds is a backgrounded phone or a
 *  closed laptop, not a slow network. */
const HOST_QUIET_MS = 45_000;
/** How long a local pending row outlives its send when the hub never
 *  reports it back (an older hub without `pending`). The host folds an add
 *  in on its next beat, so by then it has shown up in the queue instead. */
const LOCAL_PENDING_MS = 60_000;
/** How long a follower's own press on the transport is believed over the
 *  hub's word. The host's beat drains the command (up to 2.5 s), the host
 *  applies it, the NEXT beat carries the new state (2.5 s more), and the
 *  poll reads it (3 s): a poll that still disagrees inside this window is
 *  simply one that has not caught up, and is overlaid rather than believed.
 *  Past it, the room is right and the press was not honoured. */
const CONTROL_HOLD_MS = 8000;
/** A seek that landed within this of where it was asked counts as honoured. */
const SEEK_AGREE_MS = 3000;

/** Where a follower hears each room, remembered on this device. Client-only:
 *  never posted, never on the room. `{[roomId]: 'device' | 'speaker'}`. */
const HEAR_KEY = 'attackfm-groove-hear';

function readHearMap(): Record<string, HearMode> {
  try {
    const raw = localStorage.getItem(HEAR_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, HearMode> = {};
    for (const [id, mode] of Object.entries(parsed as Record<string, unknown>)) {
      if (mode === 'device' || mode === 'speaker') out[id] = mode;
    }
    return out;
  } catch {
    return {};
  }
}

function writeHearMap(map: Record<string, HearMode>): void {
  try {
    localStorage.setItem(HEAR_KEY, JSON.stringify(map));
  } catch {
    // Storage refused: the choice lasts the session, and the room asks again
    // next time - which is the worst this can cost.
  }
}

/** Nearby rooms this device has already been offered, `{[roomId]: at}`.
 *  Client-only. A room is offered ONCE per device: answered or not, put down
 *  or joined, it is never raised again - only a NEW room (a new id, after
 *  this one ended) is. */
const NEARBY_SEEN_KEY = 'attackfm-groove-nearby-seen';
/** Entries older than this that no longer stand in the feed are let go, so
 *  the map does not grow one row per room the household ever opened. */
const NEARBY_SEEN_TTL_MS = 7 * 86_400_000;

function readNearbySeen(): Record<string, number> {
  try {
    const raw = localStorage.getItem(NEARBY_SEEN_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, number> = {};
    for (const [id, at] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

function writeNearbySeen(map: Record<string, number>): void {
  try {
    localStorage.setItem(NEARBY_SEEN_KEY, JSON.stringify(map));
  } catch {
    // Storage refused: the offer is remembered for the session (the ref),
    // and a relaunch may raise it once more - the worst this can cost.
  }
}

/** A follower's own press, held over the hub's word until the room has had
 *  time to honour it. See CONTROL_HOLD_MS. */
interface HeldControl {
  roomId: string;
  at: number;
  playing: boolean | null;
  /** Where the song was put (or was, at `at`), in ms. */
  positionMs: number | null;
}

/** A member's add the host has not folded in yet, as the panel draws it:
 *  the room's own row, or this device's until the hub reports it back. */
export interface PendingAdd extends JamPending {
  /** Asked for from this account - the row wears a withdraw. */
  mine: boolean;
  /** Known here before the hub has said so: the send's own Track, so the row
   *  draws at once without a library lookup. */
  track?: Track;
}

/** The pending rows in the order they will LAND: the play-next sends first
 *  (they go in right after the song on, oldest ask first), then the appends
 *  (the end of the line, oldest first) - the strip reads like the line it
 *  is about to become. Stable, so within each kind the ask order holds. */
function byLanding(rows: PendingAdd[]): PendingAdd[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => Number(b.row.next === true) - Number(a.row.next === true) || a.i - b.i)
    .map(({ row }) => row);
}

interface JamValue {
  /** The room, or null when not in one. */
  current: Jam | null;
  /** Jams the listener's friends are hosting right now. */
  friendJams: Jam[];
  /** Rooms on THIS device's network that the listener is not in - hosted
   *  by a friend or not - each flagged `nearby`. Empty from an older hub. */
  nearbyJams: Jam[];
  /** Every room the listener could walk into: friends' rooms first, then the
   *  nearby ones hosted by people who are not friends. One row per id; the
   *  room this device is in is never here. */
  liveJams: Jam[];
  /**
   * The nearby room being OFFERED - "Leo started a groove nearby" - waiting
   * on Join or Not now (player/NearbyGrooveSheet). Raised once per room per
   * device, never while in a room, never for a room this listener hosts.
   * Null otherwise.
   */
  nearbyOffer: Jam | null;
  /** Answer the offer: true walks in (the same road `join` takes, listening
   *  choice and landing included); false puts it down for good. */
  answerNearby: (join: boolean) => Promise<void>;
  /** Friends asking to listen along with THIS listener, waiting to be answered. */
  invites: JamInvite[];
  /** Whether this device is the one setting the pace. */
  hosting: boolean;
  start: () => Promise<void>;
  /** Ask a friend into a room. 'along' (default) asks a playing friend to let
   *  you listen along (they host); 'jam' asks them to join a room you host. */
  invite: (to: string, kind?: 'along' | 'jam') => Promise<boolean>;
  /** Invite an online friend to groove WITH you: start a room if you have
   *  none, then ask them to join it. The one-tap "come groove" verb. */
  jamWith: (to: string) => Promise<boolean>;
  /** Several at once, from the friend picker: each asked in turn, ONE toast
   *  summarising ("Invited Kayla, Sam and Ana"; a refusal named with the
   *  hub's words). Resolves with who was asked and who was not. */
  inviteAll: (to: string[], kind?: 'along' | 'jam') => Promise<InviteOutcome>;
  /** `jamWith` for several: a room if you have none, then everyone asked. */
  jamWithAll: (to: string[]) => Promise<InviteOutcome>;
  /** Say yes to an ask - for 'along' your player becomes the clock, for 'jam'
   *  you drop into their room. The server decides from the invite's kind. */
  acceptInvite: (from: string) => Promise<boolean>;
  /** Let a listen-along ask go without a word to the asker. */
  declineInvite: (from: string) => Promise<void>;
  /** Resolves true once in the room; false (having said why) otherwise. */
  join: (id: string) => Promise<boolean>;
  leave: () => Promise<void>;
  /** A follower's add: the song goes to the ROOM for the host to fold in.
   *  Shown as pending here at once; the hub's next poll takes over the row.
   *  `next` asks for it right after the song on rather than the end of the
   *  line (the host's fold keeps the order the asks were made in). Resolves
   *  false (silently) for a song with no server id, or off a room. */
  addToRoom: (track: Track, opts?: { next?: boolean }) => Promise<boolean>;
  /** Take back one of your own pending adds. Gone locally at once; an older
   *  hub without the route is tolerated. */
  withdraw: (trackId: number) => Promise<void>;
  /** Adds the host has not folded in yet. A follower's: the hub's list, with
   *  this device's own unconfirmed sends ahead of the poll, its own rows
   *  marked `mine`. The host's: the room's list as the hub reports it - the
   *  members' sends its player has not picked up yet, none of them its own. */
  pending: PendingAdd[];
  /**
   * Where this device hears the room it follows: on its own deck, in time
   * with the host, or on the host's speaker with this deck silent. Null when
   * hosting or out of a room. A room never chosen for is heard here.
   */
  hear: HearMode | null;
  /** Switch at once, and remember it for this room. */
  setHear: (mode: HearMode) => void;
  /**
   * The room waiting on its first "where should the music play?" - set the
   * moment a join or an accept lands a follower in a room this device has
   * never chosen for, and the LANDING waits on the answer. Null otherwise.
   */
  choosing: Jam | null;
  /** Answer it. Null is the sheet being put down without a word, which is
   *  today's behaviour: heard here. Either way the room lands. */
  choose: (mode: HearMode | null) => void;
  /**
   * A follower's hand on the room's transport. The command goes to the hub,
   * the host's player applies it on its next beat, and until the room's own
   * word catches up the press is believed here: a pause looks paused at once,
   * a seek moves the clock at once. Resolves false (having said why) when the
   * hub refused. A host's deck answers its own presses and never calls this.
   */
  control: (action: JamControlAction, positionMs?: number) => Promise<boolean>;
  /** The host closes the room for everyone (leave hands it on). */
  end: () => Promise<void>;
  refresh: () => Promise<void>;
  /** The host's Player calls this as it plays; a follower's never does.
   *  Resolves with any track ids the room has asked to add since the last
   *  beat - the play-next sends apart from the appends - for the host to
   *  fold into its queue, and the members' transport commands since, oldest
   *  first, for the host's deck to apply (all empty when throttled). */
  hostBeat: (state: {
    trackId: number | null;
    trackTitle?: string;
    trackArtist?: string;
    positionMs: number;
    playing: boolean;
    queue?: number[];
    deviceId?: string;
  }) => Promise<JamBeatReply>;
}

/** How a batch of invites went. */
export interface InviteOutcome {
  invited: string[];
  refused: { to: string; reason: string }[];
}

const JamContext = createContext<JamValue | null>(null);

export function JamProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const { toast } = useToast();
  const registryToken = useRegistryOptional()?.session?.token ?? null;
  const [current, setCurrent] = useState<Jam | null>(null);
  const [friendJams, setFriendJams] = useState<Jam[]>([]);
  const [nearbyJams, setNearbyJams] = useState<Jam[]>([]);
  const [invites, setInvites] = useState<JamInvite[]>([]);
  // The nearby room on offer, and a ref of it for the poll (which must not
  // raise a second offer over one still standing).
  const [nearbyOffer, setNearbyOffer] = useState<Jam | null>(null);
  const nearbyOfferRef = useRef<Jam | null>(null);
  nearbyOfferRef.current = nearbyOffer;
  // Nearby rooms already offered on this device, mirrored from storage.
  const nearbySeen = useRef<Record<string, number>>(readNearbySeen());
  // Invite asks already announced, so a re-poll of the same standing ask does
  // not toast it every thirty seconds. Keyed by who + when.
  const toldInvites = useRef<Set<string>>(new Set());
  // The current room, read from inside callbacks that must not close over a
  // stale `current` (the invite fast-poll, the host beat).
  const jamRef = useRef<Jam | null>(null);
  jamRef.current = current;
  // The room as last read, and the newest event already told, so a poll
  // can say what changed: who came, who went, who has the clock now - and
  // that the room ended, when it did so without us.
  const lastRoom = useRef<Jam | null>(null);
  const lastEventAt = useRef(0);
  const leaving = useRef(false);
  // Sends this device made that the hub has not reported back yet, so the
  // queue panel shows a row the moment the tap lands rather than a poll
  // later. Reconciled on every refresh - see `refresh`.
  const [localPending, setLocalPending] = useState<(PendingAdd & { roomId: string })[]>([]);
  // Withdrawn adds, hidden until a poll that ran AFTER the delete has been
  // read - a poll in flight during the delete can still carry the row.
  const withdrawn = useRef<Set<number>>(new Set());
  // This device's sends go to the hub ONE AT A TIME, in the order they were
  // made: the hub stamps a send on arrival, and "play next" lands in ask
  // order, so a record sent as twelve concurrent posts could arrive - and
  // play - shuffled. The rows show at once regardless; only the wire waits.
  const sendChain = useRef<Promise<unknown>>(Promise.resolve());
  // Where each room is heard, mirrored from storage so the choice survives a
  // relaunch and a room asked once is never asked again.
  const [hearMap, setHearMap] = useState<Record<string, HearMode>>(readHearMap);
  // The room waiting on its first choice; the landing waits with it.
  const [choosing, setChoosing] = useState<Jam | null>(null);
  // A follower's last press on the transport, believed over the poll until
  // the room has had time to honour it (or has plainly not).
  const held = useRef<HeldControl | null>(null);
  // Commands the host's own POLL carried (the hub drains them there only when
  // the host's clock has gone quiet); handed to the next beat to apply.
  const polledCommands = useRef<JamCommand[]>([]);
  // ... and the members' SENDS it carried the same way. The skeptic proved
  // a send made while the host's beats were not reaching the hub was lost:
  // the hub drained it into the poll reply and the client threw it away.
  const polledAdditions = useRef<number[]>([]);
  const polledNext = useRef<number[]>([]);

  const refresh = useCallback(async () => {
    if (!session) {
      setCurrent(null);
      setFriendJams([]);
      setNearbyJams([]);
      setNearbyOffer(null);
      setInvites([]);
      lastRoom.current = null;
      return;
    }
    try {
      const feed = await fetchJams(session);
      const read = Date.now();
      let room: Jam | null = feed.current ? { ...feed.current, receivedAt: read } : null;
      const before = lastRoom.current;
      // A press of ours the poll has not caught up with yet is overlaid on
      // what it says; one it agrees with, or one it has had every chance to
      // honour, is let go - from here the room's word is the only word.
      const h = held.current;
      if (h && (!room || room.id !== h.roomId || read - h.at > CONTROL_HOLD_MS)) held.current = null;
      else if (h && room) {
        const roomPos = room.positionMs;
        const heldPos =
          h.positionMs == null ? null : h.positionMs + ((h.playing ?? room.playing) ? read - h.at : 0);
        const playAgrees = h.playing == null || room.playing === h.playing;
        const seekAgrees = heldPos == null || Math.abs(roomPos - heldPos) < SEEK_AGREE_MS;
        if (playAgrees && seekAgrees) held.current = null;
        else {
          room = {
            ...room,
            playing: h.playing ?? room.playing,
            positionMs: heldPos ?? room.positionMs,
            receivedAt: read,
          };
        }
      }
      // The host's poll may carry the members' commands (only while its
      // player has gone quiet); the next beat applies them.
      // The hub hands them at the TOP of the feed (beside additions), not on
      // the room - read both, so an older shape is not silently dropped.
      const handed = [...feed.commands, ...(room?.commands ?? [])];
      if (room && isHost(room, session.username)) {
        if (feed.additions.length) polledAdditions.current.push(...feed.additions);
        if (feed.additionsNext.length) polledNext.current.push(...feed.additionsNext);
      }
      if (room && handed.length > 0 && isHost(room, session.username)) {
        polledCommands.current.push(...handed);
      }
      if (room) {
        const me = session.username.toLowerCase();
        for (const e of room.events ?? []) {
          if (e.at <= lastEventAt.current || e.who.toLowerCase() === me) continue;
          // Only what happened while we were in the room: a latecomer is
          // not told the whole history on arrival.
          if (before && e.at > (before.receivedAt ?? 0) - 20_000) {
            toast({
              message:
                e.kind === 'joined'
                  ? translate('player.jamEventJoined', { who: e.who })
                  : e.kind === 'left'
                    ? translate('player.jamEventLeft', { who: e.who })
                    : e.kind === 'host'
                      ? translate('player.jamEventHost', { who: e.who })
                      // A kind this build has no words for. The wire value is
                      // shown as it came, which is a diagnostic rather than a
                      // sentence, and stays English for that reason.
                      : translate('player.jamEventOther', { who: e.who, kind: e.kind }),
            });
          }
        }
        lastEventAt.current = Math.max(lastEventAt.current, ...(room.events ?? []).map((e) => e.at));
        if (before && before.id === room.id && before.hostId !== room.hostId && room.hostId !== undefined) {
          const iAmHost = room.hostName.toLowerCase() === me;
          if (iAmHost) toast({ message: translate('player.jamClockYours') });
        }
      } else if (before && !leaving.current) {
        toast({ message: translate('player.jamHostGrooveEnded', { host: before.hostName }) });
      }
      leaving.current = false;
      lastRoom.current = room;
      setCurrent(room);
      // Reconcile this device's own sends against what the hub now says: a
      // send the hub reports as pending is the hub's row from here on; one
      // the host has folded into the queue is a queue row; one neither has
      // heard of after a minute (an older hub) is let go. A room change
      // drops them all.
      setLocalPending((prev) => {
        if (prev.length === 0) return prev;
        const now = Date.now();
        const next = prev.filter(
          (p) =>
            room !== null &&
            p.roomId === room.id &&
            !(room.pending ?? []).some((h) => h.trackId === p.trackId) &&
            !room.queue.includes(p.trackId) &&
            now - p.at < LOCAL_PENDING_MS,
        );
        return next.length === prev.length ? prev : next;
      });
      setFriendJams(feed.friends);
      // On this network: the hub's own list, plus any friend's room it
      // flagged - one row per id, and never the room we are in.
      const near: Jam[] = [];
      for (const r of [...feed.nearby, ...feed.friends]) {
        if (!r.nearby || (room && r.id === room.id) || near.some((n) => n.id === r.id)) continue;
        near.push(r);
      }
      setNearbyJams(near);
      /*
       * THE OFFER - "someone started a groove on the same network".
       *
       * Raised from the poll, once per room per device: a room already
       * offered (answered or not) is never raised again, and only a NEW
       * room - a new id, after that one ended - is. Never while in a room
       * (the deck is where rooms are compared), never for a room this
       * listener hosts, never over an offer still standing. The seen mark
       * is written the moment the offer goes up, not when it is answered:
       * an app killed with the sheet open has still had its one ask.
       */
      const seen = nearbySeen.current;
      const now = Date.now();
      let seenChanged = false;
      for (const [id, at] of Object.entries(seen)) {
        if (now - at > NEARBY_SEEN_TTL_MS && !near.some((n) => n.id === id)) {
          delete seen[id];
          seenChanged = true;
        }
      }
      if (!room && !nearbyOfferRef.current) {
        const fresh = near.find((n) => !seen[n.id] && !isHost(n, session.username));
        if (fresh) {
          seen[fresh.id] = now;
          seenChanged = true;
          nearbyOfferRef.current = fresh;
          setNearbyOffer(fresh);
        }
      }
      if (seenChanged) writeNearbySeen(seen);
      setInvites(feed.invites);
      // A new ask, said once: "Kayla wants to listen along". The card in Live
      // now is the place to answer it; this is so it is noticed off that page.
      for (const inv of feed.invites) {
        const key = `${inv.from}\n${inv.at}`;
        if (toldInvites.current.has(key)) continue;
        toldInvites.current.add(key);
        toast({
          message:
            inv.kind === 'jam'
              ? translate('player.jamInviteFrom', { who: inv.from })
              : translate('player.jamAlongRequest', { who: inv.from }),
        });
      }
    } catch {
      // An older server without jams, or a moment offline: leave what is here.
    }
  }, [session, toast]);

  const inJam = current !== null;
  useEffect(() => {
    void refresh();
    let timer = 0;
    const schedule = () => {
      const hidden = document.visibilityState === 'hidden';
      const wait = inJam ? (hidden ? POLL_IN_JAM_HIDDEN_MS : POLL_IN_JAM_MS) : POLL_IDLE_MS;
      timer = window.setTimeout(() => {
        // Out of a room and hidden: nothing to notice until we are back.
        if (!(document.visibilityState === 'hidden' && !inJam)) void refresh();
        schedule();
      }, wait);
    };
    schedule();
    // Waking catches up immediately instead of waiting out the interval.
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [refresh, inJam]);

  const hosting = current !== null && session !== null && isHost(current, session.username);

  // Where this room is heard. A room never chosen for (restored by a poll, an
  // older install) is heard here - today's behaviour - and never asked from
  // a poll: a reload is not an arrival.
  const hear: HearMode | null = current !== null && !hosting ? (hearMap[current.id] ?? 'device') : null;
  const setHear = useCallback((mode: HearMode) => {
    const room = jamRef.current;
    if (!room) return;
    setHearMap((prev) => {
      if (prev[room.id] === mode) return prev;
      const next = { ...prev, [room.id]: mode };
      writeHearMap(next);
      return next;
    });
  }, []);

  // The choice cannot outlive the room it asks about.
  useEffect(() => {
    if (choosing && (!current || current.id !== choosing.id)) setChoosing(null);
  }, [choosing, current]);

  // Nor can the offer outlive its moment: landing in ANY room (the deck, an
  // invite, a link) takes it down, and so does the offered room ending or
  // leaving the network before it was answered.
  useEffect(() => {
    if (!nearbyOffer) return;
    if (current || !nearbyJams.some((n) => n.id === nearbyOffer.id)) setNearbyOffer(null);
  }, [nearbyOffer, current, nearbyJams]);

  // Friends first, then the nearby strangers - the deck's and the profile's
  // "Live now" read this one list.
  const liveJams = useMemo<Jam[]>(() => {
    const out = friendJams.filter((r) => !current || r.id !== current.id);
    for (const n of nearbyJams) if (!out.some((r) => r.id === n.id)) out.push(n);
    return out;
  }, [friendJams, nearbyJams, current]);

  /*
   * LANDING in a room, from this device.
   *
   * A join used to be silent when it worked: `current` changed, the poll took
   * over, and if the room's song was in the library the deck steered to it -
   * and if it was not, nothing on screen moved at all. The owner's words:
   * "there is no feedback showing that I've joined". So every way in that
   * starts HERE - Join, Accept, Start, a link - lands the same way, once,
   * from this one place: a word about where you are, the player up, and the
   * groove deck open on it. Never from a poll (a reload restoring a room you
   * were already in is not an arrival) and never from the host's beat.
   *
   * The sheet first, then the deck. The deck lives in the sheet's action row
   * and takes the arm as it mounts - or at once, on a shape with no sheet to
   * lift, where the strip's own deck is already standing (nav/grooveDoor).
   */
  const land = useCallback(
    (room: Jam) => {
      if (!session) return;
      const mine = isHost(room, session.username);
      const count = room.memberCount;
      fireNativeHaptic('success');
      toast({
        icon: <Users size={16} />,
        // The room with only its host in it does not say "1 listening" - it
        // says nothing about the count at all. That is the singular FORM of
        // the sentence rather than a branch, so it is `_one` in the catalogue
        // and a language with more than two forms gets to fill them in.
        message: mine
          ? translate('player.jamOpenedYours', { count })
          : translate('player.jamOpenedTheirs', { count, host: room.hostName }),
      });
      openNowPlaying();
      armGrooveDeck();
    },
    [session, toast],
  );

  /*
   * THE CHOICE, before the landing - a follower's first time in a room.
   *
   * Two installs of the app on one phone trade the system's audio focus, so a
   * follower whose deck plays the song pauses the host's, and back again. The
   * follower has to be able to say "not here - on their speaker", and the
   * moment to ask is on arrival, once per room: a room chosen for is never
   * asked about again. A host is never asked; the room is theirs to play. The
   * landing (toast, player, deck) waits on the answer, and putting the sheet
   * down without one is today's behaviour: heard here.
   */
  const arrive = useCallback(
    (room: Jam) => {
      if (!session) return;
      if (isHost(room, session.username) || readHearMap()[room.id]) {
        land(room);
        return;
      }
      setChoosing(room);
    },
    [session, land],
  );

  const choose = useCallback(
    (mode: HearMode | null) => {
      const room = choosing;
      setChoosing(null);
      if (!room) return;
      const picked: HearMode = mode ?? 'device';
      setHearMap((prev) => {
        const next = { ...prev, [room.id]: picked };
        writeHearMap(next);
        return next;
      });
      land(jamRef.current && jamRef.current.id === room.id ? jamRef.current : room);
    },
    [choosing, land],
  );

  const start = useCallback(async () => {
    if (!session) return;
    const room = { ...(await startJamApi(session)), receivedAt: Date.now() };
    setCurrent(room);
    land(room);
    void refresh();
  }, [session, refresh, land]);

  const join = useCallback(
    async (id: string) => {
      if (!session) return false;
      try {
        const room = { ...(await joinJamApi(session, id)), receivedAt: Date.now() };
        lastRoom.current = room;
        lastEventAt.current = Math.max(0, ...(room.events ?? []).map((e) => e.at));
        setCurrent(room);
        arrive(room);
        void refresh();
        return true;
      } catch (e) {
        // A dead code, an old hub, a moment offline - said out loud. The
        // bare `void jam.join()` this used to hang off left the tap doing
        // nothing at all.
        toast({
          message: e instanceof Error && e.message ? e.message : translate('player.jamJoinFailed'),
        });
        return false;
      }
    },
    [session, refresh, toast, arrive],
  );

  const answerNearby = useCallback(
    async (walkIn: boolean) => {
      const room = nearbyOfferRef.current;
      nearbyOfferRef.current = null;
      setNearbyOffer(null);
      if (!room || !walkIn) return;
      await join(room.id);
    },
    [join],
  );

  const invite = useCallback(
    async (to: string, kind: 'along' | 'jam' = 'along'): Promise<boolean> => {
      if (!session) return false;
      try {
        try {
          await inviteToJamApi(session, to, kind, registryToken ?? undefined);
        } catch (e) {
          // The hub knows the member but not the friendship yet - it mirrors
          // registry friends on a timer. Hand it the list now and ask once
          // more; only a second refusal is worth the listener's attention.
          if (!(e instanceof ServerError && e.status === 403 && registryToken)) throw e;
          const synced = await syncRegistryFriendsToHub(session, registryToken).catch(() => false);
          if (!synced) throw e;
          await inviteToJamApi(session, to, kind, registryToken);
        }
        toast({
          message:
            kind === 'jam'
              ? translate('player.jamInvitedTo', { who: to })
              : translate('player.jamAskedAlong', { who: to }),
        });
        // 'along' only: the room appears when THEY accept, so poll faster for a
        // beat rather than waiting out the idle interval. 'jam' needs none of
        // this - you are already the host, the room is already here.
        if (kind === 'along') {
          let tries = 0;
          const tick = () => {
            if (jamRef.current) return;
            void refresh().finally(() => {
              if (!jamRef.current && ++tries < 30) window.setTimeout(tick, 3000);
            });
          };
          window.setTimeout(tick, 3000);
        }
        return true;
      } catch (e) {
        toast({
          message: e instanceof Error && e.message ? e.message : translate('player.jamInviteFailed'),
        });
        return false;
      }
    },
    [session, toast, refresh, registryToken],
  );

  const jamWith = useCallback(
    async (to: string): Promise<boolean> => {
      if (!session) return false;
      // Be the host of a room to invite them into. `start` returns the room
      // you already have if you were already hosting, so re-inviting a second
      // friend does not spin up a new one.
      if (!jamRef.current) {
        await start();
      }
      return invite(to, 'jam');
    },
    [session, start, invite],
  );

  const inviteAll = useCallback(
    async (to: string[], kind: 'along' | 'jam' = 'jam'): Promise<InviteOutcome> => {
      const out: InviteOutcome = { invited: [], refused: [] };
      if (!session) {
        out.refused = to.map((handle) => ({ to: handle, reason: translate('player.jamNotSignedIn') }));
        return out;
      }
      // The hub may not have mirrored a fresh friendship yet: hand it the
      // list ONCE for the whole batch, on the first refusal, then retry.
      let synced: boolean | null = null;
      for (const handle of to) {
        try {
          try {
            await inviteToJamApi(session, handle, kind, registryToken ?? undefined);
          } catch (e) {
            if (!(e instanceof ServerError && e.status === 403 && registryToken)) throw e;
            if (synced === null) synced = await syncRegistryFriendsToHub(session, registryToken).catch(() => false);
            if (!synced) throw e;
            await inviteToJamApi(session, handle, kind, registryToken);
          }
          out.invited.push(handle);
        } catch (e) {
          out.refused.push({
            to: handle,
            reason:
              e instanceof Error && e.message ? e.message : translate('player.jamRefusedReason'),
          });
        }
      }
      const said = out.invited.length
        ? kind === 'jam'
          ? translate('player.jamInvitedNames', { names: sayNames(out.invited) })
          : translate('player.jamAskedNamesAlong', { names: sayNames(out.invited) })
        : '';
      const sorry = out.refused
        .map((r) => translate('player.jamRefusedLine', { who: r.to, reason: r.reason }))
        .join(' · ');
      if (said || sorry) toast({ message: [said, sorry].filter(Boolean).join(' · ') });
      if (kind === 'along' && out.invited.length) {
        let tries = 0;
        const tick = () => {
          if (jamRef.current) return;
          void refresh().finally(() => {
            if (!jamRef.current && ++tries < 30) window.setTimeout(tick, 3000);
          });
        };
        window.setTimeout(tick, 3000);
      }
      return out;
    },
    [session, toast, refresh, registryToken],
  );

  const jamWithAll = useCallback(
    async (to: string[]): Promise<InviteOutcome> => {
      if (!session) {
        return {
          invited: [],
          refused: to.map((handle) => ({
            to: handle,
            reason: translate('player.jamNotSignedIn'),
          })),
        };
      }
      if (!jamRef.current) await start();
      return inviteAll(to, 'jam');
    },
    [session, start, inviteAll],
  );

  const acceptInvite = useCallback(
    async (from: string): Promise<boolean> => {
      if (!session) return false;
      try {
        const room = { ...(await acceptJamInviteApi(session, from)), receivedAt: Date.now() };
        lastRoom.current = room;
        lastEventAt.current = Math.max(0, ...(room.events ?? []).map((e) => e.at));
        setCurrent(room);
        setInvites((prev) => prev.filter((i) => i.from.toLowerCase() !== from.toLowerCase()));
        arrive(room);
        void refresh();
        return true;
      } catch (e) {
        toast({
          message:
            e instanceof Error && e.message ? e.message : translate('player.jamAlongFailed'),
        });
        return false;
      }
    },
    [session, refresh, toast, arrive],
  );

  const declineInvite = useCallback(
    async (from: string) => {
      setInvites((prev) => prev.filter((i) => i.from.toLowerCase() !== from.toLowerCase()));
      if (session) await declineJamInviteApi(session, from).catch(() => {});
    },
    [session],
  );

  const leave = useCallback(async () => {
    if (!session || !current) return;
    const id = current.id;
    leaving.current = true;
    lastRoom.current = null;
    held.current = null;
    setChoosing(null);
    setCurrent(null);
    try {
      await leaveJamApi(session, id);
    } finally {
      void refresh();
    }
  }, [session, current, refresh]);

  const end = useCallback(async () => {
    if (!session || !current) return;
    const id = current.id;
    leaving.current = true;
    lastRoom.current = null;
    held.current = null;
    setChoosing(null);
    setCurrent(null);
    try {
      await endJamApi(session, id);
    } catch {
      // An older hub without /end: leaving is the closest it has.
      await leaveJamApi(session, id).catch(() => {});
    } finally {
      void refresh();
    }
  }, [session, current, refresh]);

  // The host's clock. Posted on a throttle rather than on every tick: the
  // followers carry the position forward themselves between updates, so this
  // only has to correct the drift and announce the discontinuities.
  const lastPost = useRef(0);
  const hostBeat = useCallback(
    async (state: {
      trackId: number | null;
      trackTitle?: string;
      trackArtist?: string;
      positionMs: number;
      playing: boolean;
      queue?: number[];
      deviceId?: string;
    }): Promise<JamBeatReply> => {
      const jam = jamRef.current;
      const none: JamBeatReply = { additions: [], additionsNext: [], commands: [] };
      if (!session || !jam || !isHost(jam, session.username)) return none;
      const now = Date.now();
      if (now - lastPost.current < 2500) return none;
      lastPost.current = now;
      // Whatever the poll carried while the player was quiet goes first: it
      // was asked for earlier than anything this beat brings back.
      const carried = polledCommands.current.splice(0);
      const carriedAdds = polledAdditions.current.splice(0);
      const carriedNext = polledNext.current.splice(0);
      try {
        // Statically imported, like the rest of this file's use of that
        // module: the dynamic form here bought nothing (`trackIdFromPath`
        // above already pulls `server.ts` into the entry chunk) and cost a
        // Rollup warning on every build, which is how a real one hides.
        const reply = await pushJamState(session, jam.id, state);
        return {
          additions: [...carriedAdds, ...reply.additions],
          additionsNext: [...carriedNext, ...reply.additionsNext],
          commands: [...carried, ...reply.commands],
        };
      } catch {
        // The room may have ended under us; the next poll notices. What the
        // poll carried is not lost with the beat: it goes back on the shelf.
        polledAdditions.current.unshift(...carriedAdds);
        polledNext.current.unshift(...carriedNext);
        return { additions: [], additionsNext: [], commands: carried };
      }
    },
    [session],
  );

  /*
   * A follower's press, local-first. The room on screen wears the press the
   * moment it lands - paused, or moved to the asked-for spot - and the poll
   * keeps wearing it until the hub's word has caught up (see `refresh`). The
   * hub's refusal takes it back and says why.
   */
  const control = useCallback(
    async (action: JamControlAction, positionMs?: number): Promise<boolean> => {
      const room = jamRef.current;
      if (!session || !room) return false;
      const now = Date.now();
      const sinceRead = room.playing && room.receivedAt ? Math.min(15_000, Math.max(0, now - room.receivedAt)) : 0;
      const carried = room.positionMs + sinceRead;
      const playing =
        action === 'play' ? true : action === 'pause' ? false : action === 'toggle' ? !room.playing : null;
      const at = action === 'seek' ? Math.max(0, Math.round(positionMs ?? 0)) : null;
      if (playing !== null || at !== null) {
        held.current = { roomId: room.id, at: now, playing, positionMs: at ?? carried };
      }
      setCurrent((prev) => {
        if (!prev || prev.id !== room.id) return prev;
        return {
          ...prev,
          playing: playing ?? prev.playing,
          positionMs: at ?? (playing !== null ? carried : prev.positionMs),
          receivedAt: playing !== null || at !== null ? now : prev.receivedAt,
          controls: (prev.controls ?? 0) + 1,
        };
      });
      try {
        await controlJamApi(session, room.id, action, at ?? undefined);
        return true;
      } catch (e) {
        held.current = null;
        toast({
          message:
            e instanceof ServerError && e.status === 403
              ? translate('player.jamNotInRoom')
              : e instanceof Error && e.message
                ? e.message
                : translate('player.jamControlFailed'),
        });
        void refresh();
        return false;
      }
    },
    [session, toast, refresh],
  );

  // A follower's add, local-first. The row is on screen before the request
  // has returned: the tap landed, and the panel should say so now rather
  // than after a poll. The hub's own list takes over on the next refresh.
  // A send asked again with the other word (added, then "play next") keeps
  // one row, wearing the latest ask; the hub's row says what it settled on.
  const addToRoom = useCallback(
    async (track: Track, opts?: { next?: boolean }): Promise<boolean> => {
      const room = jamRef.current;
      if (!session || !room || isHost(room, session.username)) return false;
      const id = trackIdFromPath(track.path);
      if (id == null) return false;
      const next = opts?.next === true;
      const me = session.username;
      withdrawn.current.delete(id);
      setLocalPending((prev) => {
        const row = { trackId: id, by: me, at: Date.now(), mine: true, next, track, roomId: room.id };
        const i = prev.findIndex((p) => p.trackId === id && p.roomId === room.id);
        if (i < 0) return [...prev, row];
        if (prev[i]!.next === next) return prev;
        return prev.map((p, j) => (j === i ? { ...p, next } : p));
      });
      const send = sendChain.current.then(() => addToJamQueue(session, room.id, id, next));
      sendChain.current = send.catch(() => undefined);
      try {
        await send;
        return true;
      } catch {
        // The room may have ended, or the hub is briefly away. The row goes
        // again: a pending add that was never received is not pending.
        setLocalPending((prev) => prev.filter((p) => !(p.trackId === id && p.roomId === room.id)));
        return false;
      }
    },
    [session],
  );

  const withdraw = useCallback(
    async (trackId: number) => {
      const room = jamRef.current;
      if (!session || !room) return;
      withdrawn.current.add(trackId);
      setLocalPending((prev) => prev.filter((p) => p.trackId !== trackId));
      try {
        await withdrawFromJamQueue(session, room.id, trackId);
      } catch {
        // An older hub without the route: the host folds it in on its next
        // beat as it always did. Nothing to say - the row is gone here.
      } finally {
        // Read the room once more AFTER the delete, so a poll that was in
        // flight cannot bring the row back; then stop hiding it.
        await refresh();
        withdrawn.current.delete(trackId);
      }
    },
    [session, refresh],
  );

  const pending = useMemo<PendingAdd[]>(() => {
    if (!current || !session) return [];
    // The host reads the room's own list: what its player has yet to fold
    // in. It never sent any of them, so none are its to withdraw here.
    if (hosting) return byLanding((current.pending ?? []).map((p) => ({ ...p, next: p.next === true, mine: false })));
    const me = session.username.toLowerCase();
    const hub: PendingAdd[] = (current.pending ?? [])
      .filter((p) => !withdrawn.current.has(p.trackId))
      .map((p) => ({ ...p, next: p.next === true, mine: p.by.toLowerCase() === me }));
    const known = new Set(hub.map((p) => p.trackId));
    const local = localPending
      .filter((p) => p.roomId === current.id && !known.has(p.trackId))
      .map(({ roomId: _roomId, ...p }) => p);
    return byLanding([...hub, ...local]);
  }, [current, session, hosting, localPending]);

  const value = useMemo<JamValue>(
    () => ({
      current,
      friendJams,
      nearbyJams,
      liveJams,
      nearbyOffer,
      answerNearby,
      invites,
      hosting,
      start,
      invite,
      jamWith,
      inviteAll,
      jamWithAll,
      acceptInvite,
      declineInvite,
      join,
      leave,
      end,
      addToRoom,
      withdraw,
      pending,
      hear,
      setHear,
      choosing,
      choose,
      control,
      refresh,
      hostBeat,
    }),
    [
      current,
      friendJams,
      nearbyJams,
      liveJams,
      nearbyOffer,
      answerNearby,
      invites,
      hosting,
      start,
      invite,
      jamWith,
      inviteAll,
      jamWithAll,
      acceptInvite,
      declineInvite,
      join,
      leave,
      end,
      addToRoom,
      withdraw,
      pending,
      hear,
      setHear,
      choosing,
      choose,
      control,
      refresh,
      hostBeat,
    ],
  );

  return <JamContext.Provider value={value}>{children}</JamContext.Provider>;
}

/** The host is named on the room; the session knows who this listener is. */
function isHost(jam: Jam, username: string): boolean {
  return jam.hostName.toLowerCase() === username.toLowerCase();
}

/**
 * Whether the host's player has gone quiet: their last beat is older than
 * the room tolerates, measured on the HUB's clock (`now` and `hostSeenAt`
 * are both its), so two phones with different ideas of the time agree. An
 * older hub reports neither, and is never said to be waiting.
 */
export function hostWaiting(room: Jam): boolean {
  if (room.hostSeenAt === undefined) return false;
  const now = room.now ?? room.receivedAt ?? Date.now();
  return now - room.hostSeenAt > HOST_QUIET_MS;
}

export function useJam(): JamValue {
  const value = useContext(JamContext);
  if (!value) throw new Error('useJam outside JamProvider');
  return value;
}

/** Reads the jam when there is a provider, and nothing when there is not -
 *  for surfaces that render in both trees. */
export function useJamOptional(): JamValue | null {
  return useContext(JamContext);
}
