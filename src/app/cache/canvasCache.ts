/**
 * Canvas clips, kept on the device.
 *
 * The same argument as the covers next door, one order of magnitude up. A clip
 * is a few megabytes of video that the now-playing screen wants the INSTANT it
 * opens, and re-fetching it every time is both the slowest thing on that
 * screen and the most wasteful: the clip for a song you play daily was being
 * pulled down daily.
 *
 * ## Why the key is not the URL
 *
 * A stored clip is served from this server as `/api/canvas/media/{id}` with
 * the stream token on the query string, and that token is renewed roughly
 * hourly. The origin moves too, the day the front door changes. Keyed by URL,
 * every clip held here would be orphaned within the hour - so entries are
 * keyed by the track id alone, under a synthetic origin that never resolves.
 *
 * A clip fetched straight from Spotify's CDN keeps its own last path segment
 * as the key, which is stable for as long as the clip is.
 */

const CACHE = 'attackfm-canvas-v1';
/** Unreachable on purpose - these keys are matched, never fetched. */
const KEY_ORIGIN = 'https://canvas.attackfm.local';
/**
 * How many clips to hold. Small on purpose: these are megabytes each, and
 * unlike covers the useful set is "things you actually play", not "everything
 * that scrolled past". Oldest out first.
 */
const CAP = 60;

/** Object URLs currently handed out, one per key, revoked as they are
 *  replaced - a long session must not leak a blob per song played. */
const live = new Map<string, string>();

function store(): Promise<Cache> | null {
  if (typeof caches === 'undefined') return null;
  try {
    return caches.open(CACHE);
  } catch {
    return null;
  }
}

/** The stable identity of a clip, out of whatever URL we are holding. */
export function canvasKey(url: string | null): string | null {
  if (!url || !/^https?:/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    const stored = parsed.pathname.match(/\/api\/canvas\/media\/([^/?]+)/)?.[1];
    if (stored) return `${KEY_ORIGIN}/track/${stored}`;
    // Somebody else's CDN: its own filename is as stable as the clip is.
    const leaf = parsed.pathname.split('/').filter(Boolean).pop();
    return leaf ? `${KEY_ORIGIN}/remote/${leaf}` : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a clip once: keep it, and hand back the blob to play from.
 *
 * Deliberately not "show the URL, cache it in the background". A <video> does
 * not load through the HTTP cache - it goes out through the media stack with
 * Range requests, which that cache is not obliged to answer (dateCanvas.ts
 * hit this same wall). So a caching pass beside a playing <video> downloads
 * the clip TWICE: once for the screen and once for the cupboard, megabytes
 * each, on a phone.
 *
 * One fetch, then, and the element plays from the bytes we already hold. The
 * cost is that playback waits for the whole file rather than streaming it -
 * fine for a clip of a few seconds, and the reveal now waits for real frames
 * regardless, so there is nothing to be gained by starting early.
 *
 * Returns null when the clip cannot be had, and the caller falls back to the
 * plain URL.
 */
export async function keepCanvas(url: string): Promise<string | null> {
  const key = canvasKey(url);
  const cache = key ? store() : null;
  if (!key || !cache) return null;
  try {
    const c = await cache;
    const res = await fetch(url);
    // Only real video is worth keeping. An error page cached here would be
    // handed to a <video> forever as though it were the clip.
    if (!res.ok || !/^video\//i.test(res.headers.get('content-type') ?? '')) return null;
    await c.put(key, res.clone());
    void trim(c);
    const blob = await res.blob();
    const previous = live.get(key);
    if (previous) URL.revokeObjectURL(previous);
    const objectUrl = URL.createObjectURL(blob);
    live.set(key, objectUrl);
    return objectUrl;
  } catch {
    // Offline, quota, or a server that said no - all mean "play it live".
    return null;
  }
}

/** Oldest-first eviction. Cache API keys come back in insertion order. */
async function trim(c: Cache): Promise<void> {
  try {
    const keys = await c.keys();
    for (const stale of keys.slice(0, Math.max(0, keys.length - CAP))) {
      await c.delete(stale);
    }
  } catch {
    // A cache that will not enumerate is a cache that does not evict.
  }
}

/**
 * The held copy of a clip as a blob: URL, or null.
 *
 * A blob is what makes this worth doing at all: a <video> starts from bytes
 * already in memory without a single Range request, which is the difference
 * between the clip being there when the sheet opens and arriving after it.
 *
 * Revoked on the next call for the same key rather than never, so a long
 * session does not leak one blob per song played.
 */
export async function cachedCanvas(url: string): Promise<string | null> {
  const key = canvasKey(url);
  const cache = key ? store() : null;
  if (!key || !cache) return null;
  try {
    const hit = await (await cache).match(key);
    if (!hit) return null;
    const blob = await hit.blob();
    const previous = live.get(key);
    if (previous) URL.revokeObjectURL(previous);
    const objectUrl = URL.createObjectURL(blob);
    live.set(key, objectUrl);
    return objectUrl;
  } catch {
    return null;
  }
}

/** How many clips are held, for the storage pane to report. */
export async function canvasCacheCount(): Promise<number> {
  const cache = store();
  if (!cache) return 0;
  try {
    return (await (await cache).keys()).length;
  } catch {
    return 0;
  }
}

/** Empties the held clips - the Canvas half of Clear cache. */
export async function clearCanvasCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    await caches.delete(CACHE);
  } catch {
    // Nothing held, or nothing that will admit to being held.
  }
  for (const url of live.values()) URL.revokeObjectURL(url);
  live.clear();
}
