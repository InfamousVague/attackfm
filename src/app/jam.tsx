import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useServerSession } from './serverSession.tsx';
import {
  fetchJams,
  joinJam as joinJamApi,
  leaveJam as leaveJamApi,
  startJam as startJamApi,
  type Jam,
} from './server.ts';

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
 */
const POLL_MS = 4000;

interface JamValue {
  /** The room, or null when not in one. */
  current: Jam | null;
  /** Jams the listener's friends are hosting right now. */
  friendJams: Jam[];
  /** Whether this device is the one setting the pace. */
  hosting: boolean;
  start: () => Promise<void>;
  join: (id: string) => Promise<void>;
  leave: () => Promise<void>;
  refresh: () => Promise<void>;
  /** The host's Player calls this as it plays; a follower's never does. */
  hostBeat: (state: {
    trackId: number | null;
    positionMs: number;
    playing: boolean;
    queue?: number[];
  }) => void;
}

const JamContext = createContext<JamValue | null>(null);

export function JamProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const [current, setCurrent] = useState<Jam | null>(null);
  const [friendJams, setFriendJams] = useState<Jam[]>([]);

  const refresh = useCallback(async () => {
    if (!session) {
      setCurrent(null);
      setFriendJams([]);
      return;
    }
    try {
      const feed = await fetchJams(session);
      setCurrent(feed.current);
      setFriendJams(feed.friends);
    } catch {
      // An older server without jams, or a moment offline: leave what is here.
    }
  }, [session]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const hosting = current !== null && session !== null && isHost(current, session.username);

  const start = useCallback(async () => {
    if (!session) return;
    setCurrent(await startJamApi(session));
    void refresh();
  }, [session, refresh]);

  const join = useCallback(
    async (id: string) => {
      if (!session) return;
      setCurrent(await joinJamApi(session, id));
      void refresh();
    },
    [session, refresh],
  );

  const leave = useCallback(async () => {
    if (!session || !current) return;
    const id = current.id;
    setCurrent(null);
    try {
      await leaveJamApi(session, id);
    } finally {
      void refresh();
    }
  }, [session, current, refresh]);

  // The host's clock. Posted on a throttle rather than on every tick: the
  // followers carry the position forward themselves between updates, so this
  // only has to correct the drift and announce the discontinuities.
  const lastPost = useRef(0);
  const jamRef = useRef<Jam | null>(null);
  jamRef.current = current;
  const hostBeat = useCallback(
    (state: { trackId: number | null; positionMs: number; playing: boolean; queue?: number[] }) => {
      const jam = jamRef.current;
      if (!session || !jam || !isHost(jam, session.username)) return;
      const now = Date.now();
      if (now - lastPost.current < 2500) return;
      lastPost.current = now;
      void import('./server.ts').then(({ pushJamState }) =>
        pushJamState(session, jam.id, state).catch(() => {
          // The room may have ended under us; the next poll notices.
        }),
      );
    },
    [session],
  );

  const value = useMemo<JamValue>(
    () => ({ current, friendJams, hosting, start, join, leave, refresh, hostBeat }),
    [current, friendJams, hosting, start, join, leave, refresh, hostBeat],
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
