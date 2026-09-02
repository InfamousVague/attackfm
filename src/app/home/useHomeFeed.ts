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
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import type { Track } from '../core/tauri.ts';
import type { ResolvedMix } from './homeCards.tsx';
import { tracksOfHub } from '../server.ts';

/**
 * The home page's feed machinery: the cached-then-refreshed home and curator
 * feeds, and every shelf derived from them. One hook, because Discover's
 * curator shelves and its history shelves are the same feed read two ways -
 * splitting the loader would not save the second read (Discover mounts both).
 */

const REFRESH_MS = 5 * 60 * 1000;

export function useHomeFeed(
  tracks: Track[],
  session: ServerSession | null,
  /**
   * The collector's unadopted auditions, which the library deliberately keeps
   * OUT of `tracks` so they cannot pad anybody's album counts or searches.
   *
   * They still have to be resolvable here. The curator builds this listener's
   * own pulls into its lists now, and every id it sends is looked up in the map
   * below - so without them a list of brand new downloads resolved to nothing,
   * fell under the four-track floor, and the shelf vanished rather than showing
   * the very thing it had just been taught to build.
   */
  forYou: Track[] = [],
) {
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

  // On mount, on a slow clock, when the app comes back to the front - the
  // same rhythm the library keeps - and on a pull-to-refresh of the page
  // these shelves are on (the nonce, see nav/pageRefresh.tsx).
  const refreshNonce = useRefreshNonce();
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
  }, [refresh, refreshNonce]);

  // The id -> track map the feed's shelves resolve through. Ids the library
  // has not synced yet simply drop out.
  const byId = useMemo(() => {
    const map = new Map<number, Track>();
    for (const t of [...tracksOfHub(tracks, session), ...forYou]) {
      const id = trackIdFromPath(t.path);
      if (id !== null) map.set(id, t);
    }
    return map;
  }, [tracks, forYou]);

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
  const allCurated: ResolvedMix[] = (curator?.lists ?? [])
    .map((l) => ({
      id: `curated-${l.slug}`,
      title: l.name,
      blurb: l.blurb,
      flavor: (curator?.status.ai ? 'ai' : 'heuristic') as 'ai' | 'heuristic',
      tracks: resolve(l.trackIds),
    }))
    .filter((l) => l.tracks.length >= 4);

  /*
   * Stations are their own shelf, not more cards in the mix pile.
   *
   * The programmer writes them into the same curated table as everything else
   * (that is what makes them playable with no new contract), but a station is
   * a different PROMISE from a mix: a mix is your own music arranged, a
   * station is a place that also plays you things you have never heard. Mixed
   * into "Made from your library" they were invisible - and the Booth page
   * that once showed station-shaped things is behind developer mode, so the
   * Library shelf is the only place a person actually meets them.
   */
  const stations = allCurated.filter((l) => l.id.startsWith('curated-station-'));
  // The "Made for you" shelf: numbered Daily Mixes + the ai-vibe mood mixes +
  // the audio-character activity mixes (chill/workout/late-night/focus, all
  // `mood-*`). Split off the way stations are, so they read as one coherent
  // shelf of "here is your music, arranged" rather than scattering into the
  // grab-bag below.
  const madeForYouShelf = allCurated.filter(
    (l) => l.id.startsWith('curated-daily-') || l.id.startsWith('curated-mood-'),
  );
  // Everything ELSE stays in "Made from your library". Daylists are excluded
  // from it too - they surface only as the single live lead card (below), one
  // of the four UTC cards the server wrote, chosen for the local daypart.
  const curated = allCurated.filter(
    (l) =>
      !l.id.startsWith('curated-station-') &&
      !l.id.startsWith('curated-daily-') &&
      !l.id.startsWith('curated-mood-') &&
      !l.id.startsWith('curated-daylist-'),
  );

  // The daylist: one card that moves with the clock. The server has no
  // timezone, so it wrote four cards keyed to UTC quarter-days; here we pick
  // the one for the listener's OWN current daypart and retitle it live
  // ("Tuesday morning"). Recomputed each render off a fresh Date, so the title
  // and the chosen card follow the day with no refetch.
  const daylist = useMemo(() => {
    const now = new Date();
    // The server keyed daylist-{0..3} to real UTC quarter-day windows
    // (MoodCluster.hours is UTC), so the card for right-now is simply the
    // current UTC bucket - no timezone arithmetic. The listener's LOCAL time
    // is used only to word the heading ("Tuesday morning").
    const utc = Math.floor(now.getUTCHours() / 6);
    const l = allCurated.find((x) => x.id === `curated-daylist-${utc}`);
    if (!l || l.tracks.length < 4) return null;
    const localBucket = Math.floor(now.getHours() / 6); // 0 night, 1 morning, 2 afternoon, 3 evening
    const parts = ['night', 'morning', 'afternoon', 'evening'];
    const weekday = now.toLocaleDateString(undefined, { weekday: 'long' });
    return { ...l, title: `${weekday} ${parts[localBucket]}`, subtitle: l.title };
  }, [allCurated]);

  // One shelf, not two. "From your curator" and "Made for you" were two rails
  // of identical cards that differed only in WHICH PROCESS built them - a
  // distinction with no meaning to the person reading it. Merged, the curator's
  // own lists first (they are built from a longer look at the library), deduped
  // by title so a mix that both halves produced appears once.
  const madeForYou = useMemo(() => {
    const out: { mix: ResolvedMix; curated: boolean }[] = [];
    const seen = new Set<string>();
    // Suppress a home-feed mix whose title already shows on the "Made for you"
    // shelf or as the daylist - those used to live in `curated` and seed this
    // set; now that they are split off, seed it explicitly so the AI path
    // (which can emit a "Chill"/"Daily Mix N"-titled mix) cannot double a card
    // across two shelves.
    for (const l of madeForYouShelf) seen.add(l.title.trim().toLowerCase());
    if (daylist) seen.add(daylist.subtitle.trim().toLowerCase());
    for (const mix of curated) {
      seen.add(mix.title.trim().toLowerCase());
      out.push({ mix, curated: true });
    }
    for (const mix of mixes) {
      if (seen.has(mix.title.trim().toLowerCase())) continue;
      out.push({ mix, curated: false });
    }
    return out;
  }, [curated, mixes, madeForYouShelf, daylist]);

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
    stations,
    madeForYou,
    madeForYouShelf,
    daylist,
    jumpBack,
    topArtists,
    quiet,
    skelFeed,
    skelCurator,
    anySkeleton,
  };
}
