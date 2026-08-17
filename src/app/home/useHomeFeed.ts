import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  fetchCurator,
  fetchHome,
  trackIdFromPath,
  type CuratorFeed,
  type HomeFeed,
  type ServerSession,
} from '../server.ts';
import { readFeedCache, writeFeedCache } from '../library/feedCache.ts';
import type { Track } from '../core/tauri.ts';
import type { ResolvedMix } from './homeCards.tsx';

/**
 * The home page's feed machinery: the cached-then-refreshed home and curator
 * feeds, and every shelf derived from them. One hook, because Home, Discover's
 * curator shelves and Library's history shelves are the same feed read three
 * ways - splitting the loader would mean loading it twice.
 */

const REFRESH_MS = 5 * 60 * 1000;

export function useHomeFeed(tracks: Track[], session: ServerSession | null) {
  // Every feed seeds from the last launch's answer, so the shelves paint at
  // full size on the first frame and the refresh below swaps content in place
  // - the page must never assemble itself in front of the listener twice.
  const [feed, setFeed] = useState<HomeFeed | null>(() => readFeedCache<HomeFeed>(session, 'home'));
  // What the always-running curator has built for this listener, and how far
  // its reading of the library has got. Polled on the same rhythm as the feed.
  const [curator, setCurator] = useState<CuratorFeed | null>(() =>
    readFeedCache<CuratorFeed>(session, 'curator'),
  );
  // The first launch on this account has no cache to stand on, so the shelves
  // hold as skeletons for a beat (and until their feeds answer) rather than
  // popping in one by one. `held` releases after the hold; nothing about it
  // recurs once a cache exists.
  const firstLaunch = useRef(session !== null && readFeedCache(session, 'home') === null);
  const [held, setHeld] = useState(firstLaunch.current);
  useEffect(() => {
    if (!held) return;
    const t = window.setTimeout(() => setHeld(false), 1000);
    return () => window.clearTimeout(t);
  }, [held]);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const refresh = useCallback(async () => {
    const s = sessionRef.current;
    if (!s) return;
    try {
      const fresh = await fetchHome(s);
      setFeed(fresh);
      writeFeedCache(s, 'home', fresh);
    } catch {
      // Unreachable right now; whatever is on screen stays.
    }
    try {
      const fresh = await fetchCurator(s);
      setCurator(fresh);
      writeFeedCache(s, 'curator', fresh);
    } catch {
      // An older server with no curator, or one that is busy. The shelf simply
      // does not appear; nothing else on the page depends on it.
    }
  }, []);

  // On mount, on a slow clock, and when the app comes back to the front -
  // the same rhythm the library keeps.
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_MS);
    const wake = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [refresh]);

  // The id -> track map the feed's shelves resolve through. Ids the library
  // has not synced yet simply drop out.
  const byId = useMemo(() => {
    const map = new Map<number, Track>();
    for (const t of tracks) {
      const id = trackIdFromPath(t.path);
      if (id !== null) map.set(id, t);
    }
    return map;
  }, [tracks]);

  const resolve = useCallback(
    (ids: number[] | undefined): Track[] =>
      (ids ?? []).map((id) => byId.get(id)).filter((t): t is Track => t !== undefined),
    [byId],
  );

  const recent = resolve(feed?.recent);
  const heavy = resolve(feed?.heavy);
  // Signed out there is no feed; the library's own newest still make a shelf.
  const fresh = feed
    ? resolve(feed.fresh)
    : [...tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 24);
  const mixes: ResolvedMix[] = (feed?.mixes ?? [])
    .map((m) => ({ id: m.id, title: m.title, blurb: m.blurb, flavor: m.flavor, tracks: resolve(m.trackIds) }))
    .filter((m) => m.tracks.length >= 4);

  // The curator's own lists, resolved against the synced library. Kept
  // separate from the home feed's mixes: those are built when the page asks,
  // these are built by a process that has been reading this listener's history
  // and the library's tempos and lyrics in the background since boot.
  const curated: ResolvedMix[] = (curator?.lists ?? [])
    .map((l) => ({
      id: `curated-${l.slug}`,
      title: l.name,
      blurb: l.blurb,
      flavor: (curator?.status.ai ? 'ai' : 'heuristic') as 'ai' | 'heuristic',
      tracks: resolve(l.trackIds),
    }))
    .filter((l) => l.tracks.length >= 4);

  // One shelf, not two. "From your curator" and "Made for you" were two rails
  // of identical cards that differed only in WHICH PROCESS built them - a
  // distinction with no meaning to the person reading it. Merged, the curator's
  // own lists first (they are built from a longer look at the library), deduped
  // by title so a mix that both halves produced appears once.
  const madeForYou = useMemo(() => {
    const out: { mix: ResolvedMix; curated: boolean }[] = [];
    const seen = new Set<string>();
    for (const mix of curated) {
      seen.add(mix.title.trim().toLowerCase());
      out.push({ mix, curated: true });
    }
    for (const mix of mixes) {
      if (seen.has(mix.title.trim().toLowerCase())) continue;
      out.push({ mix, curated: false });
    }
    return out;
  }, [curated, mixes]);

  // Jump back in: each album arrives as its own ordered id list (the server
  // grouped by album artist and sorted by disc/track), so the client just
  // resolves and plays it - no name matching, no way to merge two albums that
  // share a title. The first track carries the card's cover and album name.
  const jumpBack = useMemo(
    () =>
      (feed?.jumpBackIn ?? [])
        .map((ids) => resolve(ids))
        .filter((album) => album.length > 0),
    [feed, resolve],
  );

  // Top artists: a name plus a cover found in the library (first track by that
  // artist that has art). Tapping opens the artist's page.
  const topArtists = useMemo(() => {
    return (feed?.topArtists ?? [])
      .map((name) => {
        const cover = tracks.find((t) => t.artist === name && t.artwork)?.artwork ?? null;
        return { name, cover };
      })
      .filter((a) => tracks.some((t) => t.artist === a.name));
  }, [feed, tracks]);

  const quiet =
    recent.length === 0 && heavy.length === 0 && mixes.length === 0 && jumpBack.length === 0;

  // Which shelves still wait on their first answer. The held beat covers the
  // first launch whole; after it, a feed that has not answered keeps its own
  // skeleton, so a slow reply swaps in place instead of popping the page.
  // Signed out none of this runs - there are no feeds to wait for.
  const wantsFeed = session !== null;
  const skelFeed = held || (wantsFeed && feed === null);
  const skelCurator = held || (wantsFeed && curator === null);
  const anySkeleton = skelFeed || skelCurator;

  return {
    feed,
    curator,
    recent,
    heavy,
    fresh,
    mixes,
    curated,
    madeForYou,
    jumpBack,
    topArtists,
    quiet,
    skelFeed,
    skelCurator,
    anySkeleton,
  };
}
