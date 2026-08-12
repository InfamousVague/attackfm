//! The endless station, client side.
//!
//! A station is not a playlist: it has no end and no fixed order. This holds
//! the dial (what it is seeded from, how hard, how familiar) and one promise -
//! that the queue never runs dry while it is on. When the run ahead drops
//! below `LOW`, it asks the hub for another handful, excluding what is already
//! queued so a page never repeats the last one.
//!
//! Deliberately NOT a queue of its own. The app already has one queue and one
//! deck; a station that kept a second list would fight the first over what
//! "next" means. It simply feeds the existing queue and stops when switched
//! off - everything already queued stays, because the listener asked for it.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { fetchRadio, trackIdFromPath } from './server.ts';
import type { Track } from './tauri.ts';

/** Refill when fewer than this many are still ahead. */
const LOW = 4;
/** How many to ask for each time. Small: the dial can move between pages. */
const PAGE = 12;

export interface RadioDial {
  /** -1 calmer .. 1 harder. */
  energy: number;
  /** 0 deep cuts .. 1 favourites. */
  familiar: number;
}

interface RadioValue {
  /** On, and what it started from (null once the seed has played out). */
  on: boolean;
  seed: Track | null;
  dial: RadioDial;
  /** Whose taste is blended in with yours, when the house is listening. */
  blendWith: number | null;
  setBlendWith: (userId: number | null) => void;
  /** True while a refill is in the air, for the surfaces that say so. */
  filling: boolean;
  start: (seed?: Track | null) => void;
  stop: () => void;
  setDial: (next: Partial<RadioDial>) => void;
}

const Ctx = createContext<RadioValue | null>(null);

export function RadioProvider({
  children,
  queue,
  onExtend,
}: {
  children: ReactNode;
  /** What is still ahead on the deck - the station watches this to know when
   *  to refill, and excludes it so a page never repeats. */
  queue: readonly Track[];
  /** Hand these to the queue. The deck owns the queue; the station only feeds
   *  it, so nothing here has to know how playback works. */
  onExtend: (tracks: Track[]) => void;
}) {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const [on, setOn] = useState(false);
  const [seed, setSeed] = useState<Track | null>(null);
  const [dial, setDialState] = useState<RadioDial>({ energy: 0, familiar: 0.5 });
  const [blendWith, setBlendWithState] = useState<number | null>(null);
  const [filling, setFilling] = useState(false);
  // Every id the station has handed over this run, so a long evening does not
  // circle back to the same songs. Reset when the station is switched off.
  const served = useRef<number[]>([]);
  // A station whose hub has nothing left to offer must stop asking. Without
  // this the effect re-fires on every render while the queue is short - the
  // library is small, or every candidate is already served - and a dry answer
  // becomes a request loop. Turning a dial or reseeding is a new question, so
  // it lifts.
  const dry = useRef(false);

  const byId = useMemo(() => {
    const map = new Map<number, Track>();
    for (const t of tracks) {
      const id = trackIdFromPath(t.path);
      if (id !== null) map.set(id, t);
    }
    return map;
  }, [tracks]);

  const stop = useCallback(() => {
    setOn(false);
    setSeed(null);
    setBlendWithState(null);
    served.current = [];
    dry.current = false;
  }, []);

  const start = useCallback((from?: Track | null) => {
    served.current = [];
    dry.current = false;
    setSeed(from ?? null);
    setOn(true);
  }, []);

  const setBlendWith = useCallback((userId: number | null) => {
    // A different pair of ears is a different question - see `dry`.
    dry.current = false;
    setBlendWithState(userId);
  }, []);

  const setDial = useCallback((next: Partial<RadioDial>) => {
    // A moved dial is a different question, so anything that came back empty
    // before is worth asking again.
    dry.current = false;
    setDialState((prev) => ({ ...prev, ...next }));
  }, []);

  // The one job: keep the run ahead longer than LOW. Runs on every queue
  // change, which is exactly when the answer can have changed.
  const busy = useRef(false);
  useEffect(() => {
    if (!on || !session || busy.current || dry.current) return;
    if (queue.length > LOW) return;
    busy.current = true;
    setFilling(true);
    const ahead = queue.map((t) => trackIdFromPath(t.path)).filter((id): id is number => id !== null);
    const seedId = seed ? trackIdFromPath(seed.path) : null;
    void fetchRadio(session, {
      seed: seedId,
      with: blendWith,
      energy: dial.energy,
      familiar: dial.familiar,
      n: PAGE,
      exclude: [...served.current, ...ahead],
    })
      .then((ids) => {
        const next = ids.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined);
        if (next.length > 0) {
          served.current = [...served.current, ...ids].slice(-400);
          onExtend(next);
        } else {
          // Nothing new to give: rest until the question changes.
          dry.current = true;
        }
      })
      .catch(() => {
        // An old server without the endpoint, or a moment offline: the station
        // simply stops feeding rather than throwing. What is queued still plays.
      })
      .finally(() => {
        busy.current = false;
        setFilling(false);
      });
  }, [on, session, queue, seed, dial, blendWith, byId, onExtend]);

  const value = useMemo<RadioValue>(
    () => ({ on, seed, dial, filling, blendWith, setBlendWith, start, stop, setDial }),
    [on, seed, dial, filling, blendWith, setBlendWith, start, stop, setDial],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The station, for the surfaces that steer it. Null outside the provider so
 *  a plugin page can ask without assuming the app's shape. */
export function useRadioOptional(): RadioValue | null {
  return useContext(Ctx);
}

export function useRadio(): RadioValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useRadio outside RadioProvider');
  return value;
}
