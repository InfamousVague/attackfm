import { createContext, useContext, type ReactNode } from 'react';

/**
 * "Refresh" meaning the page in front of you, not just the library.
 *
 * The pull gesture re-read the LIBRARY and nothing else: on a server that is
 * a real refresh (ask the box to re-walk its folder, pull the delta), but it
 * left every page that fetches its own data - the Booth's set, a playlist,
 * this week's stats, the downloads queue - showing whatever it had loaded on
 * mount. Pulling on those pages appeared to do nothing, because for them it
 * did nothing.
 *
 * The mechanism is a counter rather than a registry of callbacks, because of
 * how these pages are actually written: each loads inside a `useEffect` keyed
 * on what it depends on. Adding this number to that dep list is a one-line
 * change per page and re-runs the fetch that is already there - no page has
 * to grow a `refetch` it did not need, and a page added later gets the
 * behaviour by listing one more dep.
 *
 * The trade-off, stated plainly: App cannot know when those effects finish,
 * so the spinner is timed by the library pass rather than by the page's own.
 * That is the honest 90% - the library pass is usually the slowest of them -
 * and a page whose fetch outlives it simply lands a moment after the mark
 * lets go, which is what a refresh looks like anyway.
 */

const PageRefreshContext = createContext(0);

export function PageRefreshProvider({ nonce, children }: { nonce: number; children: ReactNode }) {
  return <PageRefreshContext.Provider value={nonce}>{children}</PageRefreshContext.Provider>;
}

/**
 * A number that changes when the user pulls to refresh. Put it in the dep list
 * of whatever effect loads the page's data:
 *
 *     const refresh = useRefreshNonce();
 *     useEffect(() => { void load(); }, [session, refresh]);
 *
 * It is 0 outside the provider, so a component rendered on its own still
 * mounts and fetches exactly once.
 */
export function useRefreshNonce(): number {
  return useContext(PageRefreshContext);
}
