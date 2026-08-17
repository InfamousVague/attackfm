/**
 * What a launch from a dead process throws away.
 *
 * The app keeps two very different things in local storage, and telling them
 * apart is the whole job here:
 *
 *   STATE   the session, what plugins are installed, every preference, the
 *           device's own identity. Losing any of it is a visible injury - a
 *           sign-out, an uninstall, a theme reset - and none of it is
 *           recoverable by asking the server nicely.
 *
 *   CACHE   the last answer a feed gave, kept only so the next launch can
 *           paint shelves at full size instead of reflowing (see feedCache).
 *           Every one of these is re-fetched moments later anyway.
 *
 * Only the second kind is dropped, and only on a cold start. A resumed app
 * keeps its cache, because there the cache is doing its job: the shelves are
 * already on screen and re-seeding them would be a flicker for nothing.
 *
 * A cold start is detected with a marker in sessionStorage, which dies with
 * the web view - so a fully killed app comes back without it, while
 * backgrounding and resuming keeps it. The failure mode is benign in both
 * directions: a webview reaped under memory pressure reads as cold and costs
 * one extra fetch, and a missed cold start just means a launch behaves the way
 * every launch used to.
 */

/** Feed answers cached per server+account. The only thing dropped here. */
const CACHE_PREFIX = 'attackfm-cache-';

/** Set for as long as this web view lives; absent means a fresh process. */
const WARM_KEY = 'attackfm-warm';

/**
 * Whether this is the first render since the app was actually killed, rather
 * than resumed. Consumes the signal: the answer is only true once per launch.
 */
export function isColdStart(): boolean {
  try {
    const warm = sessionStorage.getItem(WARM_KEY) !== null;
    sessionStorage.setItem(WARM_KEY, '1');
    return !warm;
  } catch {
    // Storage refused (private mode, a locked-down web view). Treating it as
    // warm keeps the cache, which is the behaviour that existed before this.
    return false;
  }
}

/**
 * Drop the cached feeds. Deliberately keyed off one prefix rather than a list
 * of names: feeds get added, and a cache nobody remembers to clear is exactly
 * the stale shelf this is here to prevent.
 */
export function clearFeedCaches(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (key?.startsWith(CACHE_PREFIX)) doomed.push(key);
    }
    // Collected first: removing during the walk renumbers the keys behind it.
    for (const key of doomed) localStorage.removeItem(key);
  } catch {
    // Nothing here is load-bearing; a launch with a stale seed still works.
  }
}

/**
 * Run once, before React mounts, so no provider ever reads a cache this was
 * about to throw away.
 */
export function runColdStartMaintenance(): void {
  if (isColdStart()) clearFeedCaches();
}
