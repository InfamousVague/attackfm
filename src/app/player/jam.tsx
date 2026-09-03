import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useToast } from '@glacier/react';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  acceptJamInvite as acceptJamInviteApi,
  declineJamInvite as declineJamInviteApi,
  endJam as endJamApi,
  fetchJams,
  inviteToJam as inviteToJamApi,
  joinJam as joinJamApi,
  leaveJam as leaveJamApi,
  startJam as startJamApi,
  type Jam,
  type JamInvite,
} from '../server.ts';

/**
 * The jam a listener is in, if any: friends following one host's clock.
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
  /** Ask a friend who is playing (same server) to let you listen along. Their
   *  accept is what starts the room; this polls faster for a beat so it appears
   *  promptly. */
  invite: (to: string) => Promise<boolean>;
  /** Say yes to a listen-along ask: your player becomes the room's clock. */
  acceptInvite: (from: string) => Promise<boolean>;
  /** Let a listen-along ask go without a word to the asker. */
  declineInvite: (from: string) => Promise<void>;
  /** Resolves true once in the room; false (having said why) otherwise. */
  join: (id: string) => Promise<boolean>;
  leave: () => Promise<void>;
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
                  ? `${e.who} joined the jam`
                  : e.kind === 'left'
                    ? `${e.who} left the jam`
                    : e.kind === 'host'
                      ? `${e.who} has the clock now`
                      : `${e.who}: ${e.kind}`,
            });
          }
        }
        lastEventAt.current = Math.max(lastEventAt.current, ...(room.events ?? []).map((e) => e.at));
        if (before && before.id === room.id && before.hostId !== room.hostId && room.hostId !== undefined) {
          const iAmHost = room.hostName.toLowerCase() === me;
          if (iAmHost) toast({ message: 'The jam is yours now - your player sets the pace' });
        }
      } else if (before && !leaving.current) {
        toast({ message: `${before.hostName}'s jam ended` });
      }
      leaving.current = false;
      lastRoom.current = room;
      setCurrent(room);
      setFriendJams(feed.friends);
      setInvites(feed.invites);
      // A new ask, said once: "Kayla wants to listen along". The card in Live
      // now is the place to answer it; this is so it is noticed off that page.
      for (const inv of feed.invites) {
        const key = `${inv.from}\n${inv.at}`;
        if (toldInvites.current.has(key)) continue;
        toldInvites.current.add(key);
        toast({ message: `${inv.from} wants to listen along` });
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
        toast({ message: e instanceof Error && e.message ? e.message : 'Could not join that jam.' });
        return false;
      }
    },
    [session, refresh, toast],
  );

  const invite = useCallback(
    async (to: string): Promise<boolean> => {
      if (!session) return false;
      try {
        await inviteToJamApi(session, to);
        toast({ message: `Asked ${to} to listen along` });
        // Poll faster for a beat so the room appears the moment they accept,
        // rather than waiting out the idle interval. Stops as soon as we are in
        // a room, or after ~90s if the ask goes unanswered.
        let tries = 0;
        const tick = () => {
          if (jamRef.current) return;
          void refresh().finally(() => {
            if (!jamRef.current && ++tries < 30) window.setTimeout(tick, 3000);
          });
        };
        window.setTimeout(tick, 3000);
        return true;
      } catch (e) {
        toast({
          message: e instanceof Error && e.message ? e.message : 'Could not ask to listen along.',
        });
        return false;
      }
    },
    [session, toast, refresh],
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

  const value = useMemo<JamValue>(
    () => ({
      current,
      friendJams,
      invites,
      hosting,
      start,
      invite,
      acceptInvite,
      declineInvite,
      join,
      leave,
      end,
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
      acceptInvite,
      declineInvite,
      join,
      leave,
      end,
      refresh,
      hostBeat,
    ],
  );

  return <JamContext.Provider value={value}>{children}</JamContext.Provider>;
}

/** The host is named on the jam; the session knows who this listener is. */
function isHost(jam: Jam, username: string): boolean {
  return jam.hostName.toLowerCase() === username.toLowerCase();
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
