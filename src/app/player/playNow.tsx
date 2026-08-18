import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { Track } from '../core/tauri.ts';
import { useLibrary } from '../library/library.tsx';

/**
 * Start a song, from anywhere it is drawn.
 *
 * Queue editing has had a context since jams needed one (queueControls.tsx),
 * but the verb people actually reach for - just play it - stayed a prop. So a
 * song was playable exactly where somebody had remembered to thread `onPlay`
 * down, and inert everywhere else: on the Downloads list, on Files on device,
 * on any surface added since. Whether a title responds to a tap should be a
 * property of the song, not of the page it happens to be on.
 *
 * This is the same `playFrom` App already owns - Connect routing, the listen
 * ledger, autoplay and the queue all still happen in one place. The context
 * only removes the requirement to have been handed it.
 */

type PlayNow = (track: Track, context?: Track[]) => void;

const PlayNowContext = createContext<PlayNow | null>(null);

export function PlayNowBridge({ play, children }: { play: PlayNow; children: ReactNode }) {
  return <PlayNowContext.Provider value={play}>{children}</PlayNowContext.Provider>;
}

/**
 * The play verb, or null outside the provider.
 *
 * Null rather than a throw: this is reached from menus and panels that also
 * render in isolation (tests, the odd standalone modal), and a surface that
 * cannot play should render an inert row rather than crash the app.
 */
export function usePlayNowOptional(): PlayNow | null {
  return useContext(PlayNowContext);
}

/**
 * Resolve a song we only know by name to the copy we actually hold.
 *
 * Some surfaces never had a Track to begin with - a download job knows a title
 * and an artist, because that is all it was given to go and fetch. This maps
 * that back onto the library, and answers null when the file is not (yet)
 * ours, which is exactly the "if it's downloaded" half of the rule: no match,
 * no click target, no lie about what a tap will do.
 *
 * Matching is case- and space-insensitive on title, then artist. Title alone
 * is not enough - `Perfect` is a dozen different songs - and the artist is
 * always present on both sides, so requiring it costs nothing and prevents
 * playing a stranger's record because the titles collided.
 */
export function useOwnedTrack(): (title: string, artist?: string) => Track | null {
  const { tracks } = useLibrary();
  const index = useMemo(() => {
    const map = new Map<string, Track>();
    const key = (t: string, a: string) => `${norm(t)}${norm(a)}`;
    for (const t of tracks) {
      // First writing wins: a library with two copies of a song should play
      // the one it found first rather than flip between them per render.
      const k = key(t.title, t.artist);
      if (!map.has(k)) map.set(k, t);
      const bare = key(t.title, '');
      if (!map.has(bare)) map.set(bare, t);
    }
    return map;
  }, [tracks]);
  return useCallback(
    (title: string, artist?: string) => {
      if (!title.trim()) return null;
      const exact = index.get(`${norm(title)}${norm(artist ?? '')}`);
      if (exact) return exact;
      // An artist we could not match is still worth a title-only look: a job
      // filed under "Dominic Fike" and a tag reading "Dominic Fike, Remi Wolf"
      // are the same recording, and refusing to play it helps nobody.
      return index.get(`${norm(title)}`) ?? null;
    },
    [index],
  );
}

/** Lowercased, punctuation-light, whitespace-collapsed - enough that a tag and
 *  a download job agree without pretending to be a real matcher. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
