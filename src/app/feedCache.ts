/**
 * The last good answer for every personalized feed - home, curator,
 * discoveries, playlists - kept per server and account, handed back
 * synchronously on the next launch.
 *
 * This exists for layout, not speed. The feeds arrive over the network, and a
 * page that renders empty and then fills is a page that jumps: shelves pop in
 * one by one, everything below them shoves down, and the same launch never
 * looks the same twice. Seeding from the cache paints the shelves at full
 * size on the first frame, and the refresh that follows swaps content in
 * place rather than reflowing the page.
 *
 * Staleness is the accepted cost and a small one - every reader refreshes
 * immediately after seeding, so the cache is only ever on screen for the
 * round-trip. A cache that fails to read or parse is simply absent, and the
 * launch behaves like the first one: skeletons, then truth.
 */

import type { ServerSession } from './server.ts';

// Bump to orphan every stored feed when a feed's shape changes; stale keys
// cost nothing and localStorage reclaims them eventually.
const VERSION = 'v1';

function cacheKey(session: ServerSession, name: string): string {
  return `attackfm-cache-${VERSION}:${session.url}|${session.username}|${name}`;
}

/** The cached feed, or null when there is none (or it will not parse). */
export function readFeedCache<T>(session: ServerSession | null, name: string): T | null {
  if (!session) return null;
  try {
    const raw = localStorage.getItem(cacheKey(session, name));
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Stores a fresh answer. Failure (quota, private mode) costs only the seed. */
export function writeFeedCache(session: ServerSession | null, name: string, value: unknown): void {
  if (!session) return;
  try {
    localStorage.setItem(cacheKey(session, name), JSON.stringify(value));
  } catch {
    // The feed still rendered; it just will not seed the next launch.
  }
}
