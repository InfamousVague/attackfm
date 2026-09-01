import { useEffect } from 'react';
import { rememberArt } from '../cache/artCache.ts';

/**
 * Warming covers before they are scrolled to.
 *
 * Every cover in every list is `loading="lazy"`, which is the right default
 * for a library of thousands: it means opening All songs does not ask the
 * server for six thousand images. What it also means is that each cover is
 * requested at the moment it enters the viewport, so a scroll outruns the
 * network and the rows arrive as skeletons that fill in behind you. On a
 * fresh library nothing is held yet, so that is every row.
 *
 * The fix is not to stop being lazy - it is to be lazy about the RIGHT
 * things. This warms a bounded window ahead of the reader and leaves the rest
 * to the browser, so the covers that are about to be needed are already in
 * `artCache` when the img asks for them.
 *
 * Deliberately built on `rememberArt` rather than a bare fetch: it is
 * idempotent (a cover already held answers `held` without touching the
 * network), it refuses to cache anything that is not an image, and it is the
 * same store `useArtLoad` reads from - so a warmed cover is a cache HIT at
 * display time rather than a second download.
 */

/** How many covers a single warm pass will fetch. A window, not a library:
 *  the point is the next screenful, and an unbounded pass on All songs would
 *  be six thousand requests racing the ones the user can actually see. */
const WINDOW = 48;

/** How many fetches are allowed in flight. Enough to fill a screen quickly,
 *  few enough that warming never starves the images the browser is fetching
 *  for rows already on screen - those are the urgent ones. */
const LANES = 4;

/** Warmed this session, so a re-render or a re-sort does not re-walk the
 *  same list. `rememberArt` would answer `held` anyway, but that is still an
 *  async cache lookup per cover per render. */
const warmed = new Set<string>();

/**
 * Fetch and hold the first `WINDOW` covers of a list, quietly.
 *
 * Fire-and-forget by design: nothing waits on this and nothing shows an error
 * if it fails. A cover that does not warm is simply fetched the old way when
 * its row appears.
 */
export function prefetchArt(urls: readonly (string | null | undefined)[]): void {
  const queue: string[] = [];
  for (const url of urls) {
    if (!url || warmed.has(url)) continue;
    warmed.add(url);
    queue.push(url);
    if (queue.length >= WINDOW) break;
  }
  if (queue.length === 0) return;

  let next = 0;
  const pump = async (): Promise<void> => {
    while (next < queue.length) {
      const url = queue[next++]!;
      try {
        await rememberArt(url);
      } catch {
        // Quiet on purpose: see the module note. The row will fetch it later.
      }
    }
  };
  for (let i = 0; i < Math.min(LANES, queue.length); i++) void pump();
}

/**
 * The hook form, for a surface that knows which covers it is about to draw.
 *
 * The dependency is the joined list of urls rather than the array, so a
 * parent re-rendering with an equal-but-new array does not start the walk
 * again - which on a table that re-sorts on every click is most renders.
 */
export function usePrefetchArt(urls: readonly (string | null | undefined)[]): void {
  const key = urls.slice(0, WINDOW).join('|');
  useEffect(() => {
    prefetchArt(urls);
    // `key` is the honest dependency here; `urls` is a fresh array each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
