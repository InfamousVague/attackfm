import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '@glacier/react';
import { useServerSession } from '../servers/serverSession.tsx';
import { trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';
import {
  acceptJamInvite as acceptJamInviteApi,
  addToJamQueue,
  withdrawFromJamQueue,
  declineJamInvite as declineJamInviteApi,
  endJam as endJamApi,
  fetchJams,
  inviteToJam as inviteToJamApi,
  joinJam as joinJamApi,
  leaveJam as leaveJamApi,
  startJam as startJamApi,
  type Jam,
  type JamInvite,
  type JamPending,
} from '../server.ts';

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

/** A member's add the host has not folded in yet, as the panel draws it:
 *  the room's own row, or this device's until the hub reports it back. */
export interface PendingAdd extends JamPending {
  /** Asked for from this account - the row wears a withdraw. */
  mine: boolean;
  /** Known here before the hub has said so: the send's own Track, so the row
   *  draws at once without a library lookup. */
  track?: Track;
}

interface JamValue {
  /** The room, or null when not in one. */
  current: Jam | null;
  /** Jams the listener's friends are hosting right now. */
  friendJams: Jam[];
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
   *  Resolves false (silently) for a song with no server id, or off a room. */
  addToRoom: (track: Track) => Promise<boolean>;
  /** Take back one of your own pending adds. Gone locally at once; an older
   *  hub without the route is tolerated. */
  withdraw: (trackId: number) => Promise<void>;
  /** Adds the host has not folded in yet - the hub's list, with this device's
   *  own unconfirmed sends ahead of the poll. Empty when hosting. */
  pending: PendingAdd[];
  /** The host closes the room for everyone (leave hands it on). */
  end: () => Promise<void>;
  refresh: () => Promise<void>;
  /** The host's Player calls this as it plays; a follower's never does.
   *  Resolves with any track ids the room has asked to add since the last
   *  beat, for the host to fold into its queue (empty when throttled). */
  hostBeat: (state: {
    trackId: number | null;
    trackTitle?: string;
    trackArtist?: string;
    positionMs: number;
    playing: boolean;
    queue?: number[];
    deviceId?: string;
  }) => Promise<number[]>;
}

const JamContext = createContext<JamValue | null>(null);

export function JamProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const { toast } = useToast();
  const [current, setCurrent] = useState<Jam | null>(null);
  const [friendJams, setFriendJams] = useState<Jam[]>([]);
  const [invites, setInvites] = useState<JamInvite[]>([]);
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

  const refresh = useCallback(async () => {
    if (!session) {
      setCurrent(null);
      setFriendJams([]);
      setInvites([]);
      lastRoom.current = null;
      return;
    }
    try {
      const feed = await fetchJams(session);
      const room = feed.current ? { ...feed.current, receivedAt: Date.now() } : null;
      const before = lastRoom.current;
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
                  ? `${e.who} joined the groove`
                  : e.kind === 'left'
                    ? `${e.who} left the groove`
                    : e.kind === 'host'
                      ? `${e.who} has the clock now`
                      : `${e.who}: ${e.kind}`,
            });
          }
        }
        lastEventAt.current = Math.max(lastEventAt.current, ...(room.events ?? []).map((e) => e.at));
        if (before && before.id === room.id && before.hostId !== room.hostId && room.hostId !== undefined) {
          const iAmHost = room.hostName.toLowerCase() === me;
          if (iAmHost) toast({ message: 'The groove is yours now - your player sets the pace' });
        }
      } else if (before && !leaving.current) {
        toast({ message: `${before.hostName}'s groove ended` });
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
              ? `${inv.from} invited you to groove`
              : `${inv.from} wants to listen along`,
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

  const start = useCallback(async () => {
    if (!session) return;
    setCurrent(await startJamApi(session));
    void refresh();
  }, [session, refresh]);

  const join = useCallback(
    async (id: string) => {
      if (!session) return false;
      try {
        const room = { ...(await joinJamApi(session, id)), receivedAt: Date.now() };
        lastRoom.current = room;
        lastEventAt.current = Math.max(0, ...(room.events ?? []).map((e) => e.at));
        setCurrent(room);
        void refresh();
        return true;
      } catch (e) {
        // A dead code, an old hub, a moment offline - said out loud. The
        // bare `void jam.join()` this used to hang off left the tap doing
        // nothing at all.
        toast({ message: e instanceof Error && e.message ? e.message : 'Could not join that groove.' });
        return false;
      }
    },
    [session, refresh, toast],
  );

  const invite = useCallback(
    async (to: string, kind: 'along' | 'jam' = 'along'): Promise<boolean> => {
      if (!session) return false;
      try {
        await inviteToJamApi(session, to, kind);
        toast({ message: kind === 'jam' ? `Invited ${to} to groove` : `Asked ${to} to listen along` });
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
        toast({ message: e instanceof Error && e.message ? e.message : 'Could not send that invite.' });
        return false;
      }
    },
    [session, toast, refresh],
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

  const acceptInvite = useCallback(
    async (from: string): Promise<boolean> => {
      if (!session) return false;
      try {
        const room = { ...(await acceptJamInviteApi(session, from)), receivedAt: Date.now() };
        lastRoom.current = room;
        lastEventAt.current = Math.max(0, ...(room.events ?? []).map((e) => e.at));
        setCurrent(room);
        setInvites((prev) => prev.filter((i) => i.from.toLowerCase() !== from.toLowerCase()));
        void refresh();
        return true;
      } catch (e) {
        toast({
          message:
            e instanceof Error && e.message ? e.message : 'Could not start listening along.',
        });
        return false;
      }
    },
    [session, refresh, toast],
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
    }): Promise<number[]> => {
      const jam = jamRef.current;
      if (!session || !jam || !isHost(jam, session.username)) return [];
      const now = Date.now();
      if (now - lastPost.current < 2500) return [];
      lastPost.current = now;
      try {
        const { pushJamState } = await import('../server.ts');
        return await pushJamState(session, jam.id, state);
      } catch {
        // The room may have ended under us; the next poll notices.
        return [];
      }
    },
    [session],
  );

  // A follower's add, local-first. The row is on screen before the request
  // has returned: the tap landed, and the panel should say so now rather
  // than after a poll. The hub's own list takes over on the next refresh.
  const addToRoom = useCallback(
    async (track: Track): Promise<boolean> => {
      const room = jamRef.current;
      if (!session || !room || isHost(room, session.username)) return false;
      const id = trackIdFromPath(track.path);
      if (id == null) return false;
      const me = session.username;
      withdrawn.current.delete(id);
      setLocalPending((prev) =>
        prev.some((p) => p.trackId === id && p.roomId === room.id)
          ? prev
          : [...prev, { trackId: id, by: me, at: Date.now(), mine: true, track, roomId: room.id }],
      );
      try {
        await addToJamQueue(session, room.id, id);
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
    if (!current || !session || hosting) return [];
    const me = session.username.toLowerCase();
    const hub: PendingAdd[] = (current.pending ?? [])
      .filter((p) => !withdrawn.current.has(p.trackId))
      .map((p) => ({ ...p, mine: p.by.toLowerCase() === me }));
    const known = new Set(hub.map((p) => p.trackId));
    const local = localPending
      .filter((p) => p.roomId === current.id && !known.has(p.trackId))
      .map(({ roomId: _roomId, ...p }) => p);
    return [...hub, ...local];
  }, [current, session, hosting, localPending]);

  const value = useMemo<JamValue>(
    () => ({
      current,
      friendJams,
      invites,
      hosting,
      start,
      invite,
      jamWith,
      acceptInvite,
      declineInvite,
      join,
      leave,
      end,
      addToRoom,
      withdraw,
      pending,
      refresh,
      hostBeat,
    }),
    [
      current,
      friendJams,
      invites,
      hosting,
      start,
      invite,
      jamWith,
      acceptInvite,
      declineInvite,
      join,
      leave,
      end,
      addToRoom,
      withdraw,
      pending,
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
