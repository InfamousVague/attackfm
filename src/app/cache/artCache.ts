/**
 * Covers, kept on the device.
 *
 * Art was the one thing the app never held. Songs are pinned by the sweep and
 * the liked list survives in localStorage, so a dark home server left a
 * library that played and remembered its hearts - drawn entirely in grey
 * placeholder squares. The ladder in artLoad had a rung for a mirror, but a
 * phone with no mirror configured (the ordinary case) fell straight past it.
 *
 * The store is the Cache API rather than localStorage: these are image bytes,
 * megabytes of them, which a 5MB string quota cannot hold.
 *
 * ## Why the key is not the URL
 *
 * An art URL carries the stream token (`?t=…`) and the server's own origin,
 * and both move: the token is renewed roughly hourly, and the origin changes
 * the day the front door does - which is exactly what happened when
 * matt.attack.fm started fronting the home library. Keyed by URL, every cover
 * in the cache would be orphaned by either event, which is the failure this
 * exists to prevent.
 *
 * So entries are keyed by what does NOT move: the art id and the size
 * variant, under a synthetic origin that never resolves.
 */

const CACHE = 'attackfm-art-v1';
/** A host that cannot be reached on purpose - these keys are never fetched,
 *  only matched against. */
const KEY_ORIGIN = 'https://art.attackfm.local';

/** Whether this engine has the Cache API at all (it is absent in some
 *  insecure-context WebViews, and on a plain http:// dev server). */
function store(): Promise<Cache> | null {
  if (typeof caches === 'undefined') return null;
  try {
    return caches.open(CACHE);
  } catch {
    return null;
  }
}

/**
 * The stable identity of a cover, pulled back out of whatever URL a surface
 * happens to be holding.
 *
 * Returns null for anything that is not server art - a local file's cover is
 * a blob: URL, which is already on the device and has no id to key on.
 */
export function artKey(url: string | null): string | null {
  if (!url || !/^https?:/i.test(url)) return null;
  try {
    const parsed = new URL(url);
    const id = parsed.pathname.match(/\/api\/art\/([^/?]+)/)?.[1];
    if (!id) return null;
    // The size variant is part of the identity: a 160 thumb must not be
    // served where a 640 card was asked for, or shelves go soft.
    const size = parsed.searchParams.get('size') ?? 'full';
    return `${KEY_ORIGIN}/${id}@${size}`;
  } catch {
    return null;
  }
}

/**
 * Keep a copy of a cover that has just been shown.
 *
 * Called after a successful <img> load, so the bytes are already in the
 * engine's own HTTP cache and this second request is usually served without
 * touching the network. Deliberately quiet: a cover that fails to cache is a
 * cover that will be fetched again, which is not worth a word to anyone.
 *
 * The answer says what happened - already `held`, freshly `kept`, or `no` -
 * because the sweep's backfill budgets NETWORK ATTEMPTS per pass, and a match
 * that cost nothing must not spend that budget. Display callers ignore it.
 */
export async function rememberArt(url: string): Promise<'held' | 'kept' | 'no'> {
  const key = artKey(url);
  const cache = key ? store() : null;
  if (!key || !cache) return 'no';
  try {
    const c = await cache;
    if (await c.match(key)) return 'held'; // already held; do not re-fetch
    const res = await fetch(url);
    // Only a real image is worth keeping. An error page cached here would be
    // served forever as though it were the cover.
    if (!res.ok || !/^image\//i.test(res.headers.get('content-type') ?? '')) return 'no';
    await c.put(key, res);
    return 'kept';
  } catch {
    // Offline, quota, or a server that said no - all mean "no copy", which
    // the ladder already handles.
    return 'no';
  }
}

/**
 * The held copy of a cover, as a URL an <img> can use, or null.
 *
 * Object URLs are revoked on the next call for the same key rather than
 * never: a long session scrolling a library would otherwise leak one blob
 * per cover shown.
 */
const live = new Map<string, string>();

export async function cachedArt(url: string): Promise<string | null> {
  const key = artKey(url);
  const cache = key ? store() : null;
  if (!key || !cache) return null;
  try {
    const c = await cache;
    /*
     * The exact variant first, then ANY variant of the same cover.
     *
     * Size is part of the identity on purpose - serving a 160 thumb into a 640
     * card makes a shelf go soft - but that is a judgement about which copy
     * looks best, and it only holds while there is a better one to be had. With
     * the hub dark there is no better one: the choice is a slightly soft cover
     * or a grey placeholder, and the placeholder is not the kinder answer.
     *
     * This is most of "a lot of the album art does not load": a phone that had
     * browsed shelves held piles of 160s and 320s, and every 640 the cards asked
     * for missed by a size.
     */
    const hit =
      (await c.match(key)) ??
      (await (async () => {
        const id = key.slice(0, key.lastIndexOf('@'));
        for (const req of await c.keys()) {
          if (req.url.startsWith(`${id}@`)) return c.match(req);
        }
        return undefined;
      })());
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

/** How many covers are held, for the storage pane to report. */
export async function artCacheCount(): Promise<number> {
  const cache = store();
  if (!cache) return 0;
  try {
    return (await (await cache).keys()).length;
  } catch {
    return 0;
  }
}

/** Empties the held covers - the art half of Clear cache. */
export async function clearArtCache(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    await caches.delete(CACHE);
    for (const url of live.values()) URL.revokeObjectURL(url);
    live.clear();
  } catch {
    // Nothing held, or no Cache API - either way there is nothing to empty.
  }
}
