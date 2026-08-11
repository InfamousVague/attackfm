import { Button, Pill, ScrollArea, SearchField, Text } from '@glacier/react';
import { ChartNoAxesColumn, Sparkles } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from './library.tsx';
import { mosaicArts, useCardArt, useTileArt } from './artLoad.ts';
import { ripplePatter } from './haptics.ts';
import { usePlaylists } from './playlists.tsx';
import { useServerSession } from './serverSession.tsx';
import {
  fetchCurator,
  fetchHome,
  trackIdFromPath,
  type CuratorFeed,
  type HomeFeed,
} from './server.ts';
import { filterTracks } from './trackSearch.ts';
import { readFeedCache, writeFeedCache } from './feedCache.ts';
import { ShelfSkeleton } from './ShelfSkeleton.tsx';
import { PlaylistModal } from './PlaylistModal.tsx';
import { EmptyArt } from './EmptyArt.tsx';
import { isMusicImportLink } from '../plugins/importsBridge.ts';
import type { Track } from './tauri.ts';
import { ImportFromSearch } from './ImportFromSearch.tsx';
import { TrackMenu } from './TrackMenu.tsx';

/**
 * The front door. A greeting, then shelves: the mixes made from the
 * listener's own history (model-curated when the server has one, honest
 * heuristics otherwise), then recently played, heavy rotation, and what is
 * new. Everything resolves against the already-synced library - the feed is
 * track ids, so this page costs one tiny request.
 *
 * Signed out (a local library), the history shelves have no account to read
 * from; the page keeps the greeting and builds what it can from the library
 * itself - newest additions and liked songs - rather than going blank.
 */

const REFRESH_MS = 5 * 60 * 1000;

function greetingFor(hour: number): string {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Blank line the skeleton holds so the card keeps its exact height. */
const NBSP = ' ';

/** One square track card on a shelf. */
function TrackCard({ track, onOpen }: { track: Track; onOpen: () => void }) {
  const { src, loaded, onLoad, onError } = useCardArt(track.artwork);
  const idle = !loaded || undefined;
  return (
    <TrackMenu track={track}>
      <button type="button" className="trackCard" onClick={onOpen}>
        <img className="trackCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
        <span className="trackCardTitle" data-loading={idle}>{loaded ? track.title : NBSP}</span>
        <span className="trackCardArtist" data-loading={idle}>{loaded ? track.artist : NBSP}</span>
      </button>
    </TrackMenu>
  );
}

/** An album card: cover over the album name and artist. Jump-back-in wears it. */
function AlbumCard({ track, onOpen }: { track: Track; onOpen: () => void }) {
  const { src, loaded, onLoad, onError } = useCardArt(track.artwork);
  const idle = !loaded || undefined;
  return (
    <TrackMenu track={track}>
      <button type="button" className="trackCard" onClick={onOpen}>
        <img className="trackCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
        <span className="trackCardTitle" data-loading={idle}>{loaded ? track.album || track.title : NBSP}</span>
        <span className="trackCardArtist" data-loading={idle}>{loaded ? track.artist : NBSP}</span>
      </button>
    </TrackMenu>
  );
}

/** An artist card: a round cover over the name, linking into the artist page. */
function ArtistCard({ name, cover, onOpen }: { name: string; cover: string | null; onOpen: () => void }) {
  const { src, loaded, onLoad, onError } = useCardArt(cover);
  const idle = !loaded || undefined;
  return (
    <button type="button" className="artistCard" onClick={onOpen}>
      <img className="artistCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
      <span className="artistCardName" data-loading={idle}>{loaded ? name : NBSP}</span>
    </button>
  );
}

/** A mix's cover: the 2x2 mosaic of its first artworks, glyph fallback. */
function MixCover({ tracks }: { tracks: Track[] }) {
  const arts = mosaicArts(tracks.map((t) => t.artwork));
  // Under four covers the glyph stands in, and a glyph never loads - the tile
  // hook watches exactly the urls the grid below will draw.
  const { loaded, hostRef } = useTileArt(arts.length < 4 ? [] : arts);
  if (arts.length < 4) {
    return (
      <div className="mixCardCover mixCardCover--glyph" aria-hidden>
        <Sparkles size={28} />
      </div>
    );
  }
  return (
    <div ref={hostRef} className="mixCardCover" aria-hidden data-tile-pop="" data-tile-loading={!loaded || undefined}>
      {arts.map((art, i) => (
        <img key={i} src={art} alt="" loading="lazy" />
      ))}
    </div>
  );
}

interface ResolvedMix {
  id: string;
  title: string;
  blurb: string;
  flavor: 'ai' | 'heuristic';
  tracks: Track[];
}

/** A shelf: a heading and a horizontal run of cards. Renders nothing when
 * it has nothing - an empty rail is clutter, not information. A shelf can
 * carry one action on the heading's right - a door related to what the rail
 * shows, sitting where the eye finishes reading the title. */
function Shelf({ title, children, count, action }: { title: string; children: React.ReactNode; count: number; action?: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="homeShelf">
      {action ? (
        <div className="homeShelfHead">
          <h2 className="homeShelfTitle">{title}</h2>
          {action}
        </div>
      ) : (
        <h2 className="homeShelfTitle">{title}</h2>
      )}
      <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
        <div className="homeShelfRow">{children}</div>
      </ScrollArea>
    </section>
  );
}

export function HomePage({
  onPlay,
  onOpenArtist,
  onOpenStats,
  embedded = false,
}: {
  /** Called with the opened track and the shelf it came from as the queue. */
  onPlay: (track: Track, queue: Track[]) => void;
  /** Opens an artist's page - the Top artists shelf links through here. */
  onOpenArtist: (artist: string) => void;
  /** Opens the stats page - the Top artists shelf's header door. */
  onOpenStats?: () => void;
  /** Rendered inside another page (the Library tab): drop the greeting and the
   *  page's own search field - the host carries both - and show just the
   *  personalized shelves, so the mixes fold into Library above what you own. */
  embedded?: boolean;
}) {
  const { tracks, favoriteTracks } = useLibrary();
  const { create: createPlaylist } = usePlaylists();
  const { session } = useServerSession();
  // Every feed seeds from the last launch's answer, so the shelves paint at
  // full size on the first frame and the refresh below swaps content in place
  // - the page must never assemble itself in front of the listener twice.
  // Standalone, the page patters its own arrival; embedded, the Library
  // page already did (and ripplePatter dedupes regardless).
  useEffect(() => {
    if (!embedded) ripplePatter();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, at arrival
  }, []);

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
  const [openMix, setOpenMix] = useState<ResolvedMix | null>(null);
  // The home search filters the local library in place: while it holds a query
  // the shelves stand aside and the matches take the page.
  const [query, setQuery] = useState('');
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

  const hour = new Date().getHours();
  const name = session?.username;
  const quiet =
    recent.length === 0 && heavy.length === 0 && mixes.length === 0 && jumpBack.length === 0;

  // A pasted link is an instruction, not a search term: no library contains
  // the text of a URL, so running it as a query could only ever answer "no
  // results" underneath the import that is already happening.
  const searching = query.trim().length > 0 && !isMusicImportLink(query);
  const results = useMemo(
    () => (searching ? filterTracks(tracks, query) : []),
    [searching, tracks, query],
  );

  // Which shelves still wait on their first answer. The held beat covers the
  // first launch whole; after it, a feed that has not answered keeps its own
  // skeleton, so a slow reply swaps in place instead of popping the page.
  // Signed out none of this runs - there are no feeds to wait for.
  const wantsFeed = session !== null;
  const skelFeed = held || (wantsFeed && feed === null);
  const skelCurator = held || (wantsFeed && curator === null);
  const anySkeleton = skelFeed || skelCurator;

  return (
    <div className={embedded ? 'homeMixes' : 'homePage'}>
      {!embedded && (
        <>
          <header className="homeGreeting">
            <div className="homeGreeting__text">
              <h1 className="homeGreetingTitle">
                {greetingFor(hour)}
                {name ? `, ${name}` : ''}
              </h1>
              <Text tone="muted" size="sm">
                {quiet
                  ? 'Play a few songs and this page starts learning what you like.'
                  : feed?.ai
                    ? 'Mixed for you by your own server.'
                    : 'Made from your listening.'}
              </Text>
            </div>
          </header>

          <SearchField
            className="pageSearch"
            value={query}
            onValueChange={setQuery}
            placeholder="Search, or paste a music link to import"
            aria-label="Search, or paste a music link to import"
          />
          <ImportFromSearch query={query} />
        </>
      )}

      {searching ? (
        results.length > 0 ? (
          <section className="homeShelf homeResults">
            <h2 className="homeShelfTitle">
              {results.length} {results.length === 1 ? 'result' : 'results'}
            </h2>
            <div className="homeResultsGrid">
              {results.map((t) => (
                <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, results)} />
              ))}
            </div>
          </section>
        ) : (
          <div className="emptyState">
            <EmptyArt name="search" />
            <p className="homeResultsEmpty">No songs in your library match “{query.trim()}”.</p>
          </div>
        )
      ) : (
        <>
      {/* The DJ moved up to the library page's action row, beside the
          download queue - see LibraryView. */}
      {/* "Worth adding" (curator finds from outside the library) lives on the
          Discover page now — a library surface should show what you HAVE. */}

      {skelCurator ? (
        <ShelfSkeleton title="From your curator" kind="mix" count={4} />
      ) : (
      <Shelf title="From your curator" count={curated.length}>
        {curated.map((mix) => (
          <button key={mix.id} type="button" className="mixCard" onClick={() => setOpenMix(mix)}>
            <span className="mixCardCoverWrap">
              <MixCover tracks={mix.tracks} />
              {mix.flavor === 'ai' && (
                <Pill size="sm" tone="accent" className="mixCardBadge">
                  AI
                </Pill>
              )}
            </span>
            <span className="mixCardTitle">{mix.title}</span>
            <span className="mixCardBlurb">{mix.blurb}</span>
          </button>
        ))}
      </Shelf>
      )}

      {/* While the curator is still reading the library, say so plainly with
          the count - a shelf that is thin because the work is half done should
          not look like a shelf that is thin because you have no taste. */}
      {curator && curator.progress.checked < curator.progress.total && (
        <p className="curatorNote">
          Your curator is listening through the library — {curator.progress.checked} of{' '}
          {curator.progress.total} tracks read, {curator.progress.withTempo} with a tempo
          {curator.status.embeddings ? `, ${curator.progress.withLyrics} with lyrics read` : ''}.
        </p>
      )}

      {skelFeed ? (
        <ShelfSkeleton title="Made for you" kind="mix" count={4} />
      ) : (
      <Shelf title="Made for you" count={mixes.length}>
        {mixes.map((mix) => (
          <button key={mix.id} type="button" className="mixCard" onClick={() => setOpenMix(mix)}>
            {/* The AI mark rides the artwork, not the title - a long name
                needs the whole line to say what it is, and a badge that
                shares it was the first thing a truncation had to eat. */}
            <span className="mixCardCoverWrap">
              <MixCover tracks={mix.tracks} />
              {mix.flavor === 'ai' && (
                <Pill size="sm" tone="accent" className="mixCardBadge">
                  AI
                </Pill>
              )}
            </span>
            <span className="mixCardTitle">{mix.title}</span>
            <span className="mixCardBlurb">{mix.blurb}</span>
          </button>
        ))}
      </Shelf>
      )}

      {skelFeed ? (
        <ShelfSkeleton title="Jump back in" kind="track" />
      ) : (
      <Shelf title="Jump back in" count={jumpBack.length}>
        {jumpBack.map((album) => (
          <AlbumCard
            key={album[0]!.path}
            track={album[0]!}
            onOpen={() => onPlay(album[0]!, album)}
          />
        ))}
      </Shelf>
      )}

      {skelFeed ? (
        <ShelfSkeleton title="Your top artists" kind="artist" />
      ) : (
      <Shelf
        title="Your top artists"
        count={topArtists.length}
        // The stats door lives where the listening is summarized: these
        // artists ARE the top of the stats page, so "view all" sits beside
        // them rather than as a lone header button floating over everything.
        action={
          onOpenStats && (
            <Button variant="ghost" size="sm" onClick={onOpenStats}>
              <ChartNoAxesColumn size={14} />
              <span>View all stats</span>
            </Button>
          )
        }
      >
        {topArtists.map((a) => (
          <ArtistCard key={a.name} name={a.name} cover={a.cover} onOpen={() => onOpenArtist(a.name)} />
        ))}
      </Shelf>
      )}

      {skelFeed ? (
        <ShelfSkeleton title="Recently played" kind="track" />
      ) : (
      <Shelf title="Recently played" count={recent.length}>
        {recent.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, recent)} />
        ))}
      </Shelf>
      )}

      {skelFeed ? (
        <ShelfSkeleton title="Heavy rotation" kind="track" />
      ) : (
      <Shelf title="Heavy rotation" count={heavy.length}>
        {heavy.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, heavy)} />
        ))}
      </Shelf>
      )}

      {held ? (
        <ShelfSkeleton title="New in your library" kind="track" />
      ) : (
      <Shelf title="New in your library" count={fresh.length}>
        {fresh.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, fresh)} />
        ))}
      </Shelf>
      )}

      <Shelf title="Liked" count={feed ? 0 : favoriteTracks.length}>
        {favoriteTracks.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, favoriteTracks)} />
        ))}
      </Shelf>

      {/* Embedded in the Library, this stays silent. The empty state speaks for
          a whole page ("nothing here yet, play something"), and folded into a
          page that already has playlists, stats and shelves above it, a
          full-height graphic announcing emptiness is just wrong - the page is
          plainly not empty. The host owns its own empty state. */}
      {!embedded &&
        !anySkeleton &&
        curated.length === 0 &&
        mixes.length === 0 &&
        jumpBack.length === 0 &&
        topArtists.length === 0 &&
        recent.length === 0 &&
        heavy.length === 0 &&
        fresh.length === 0 &&
        (feed ? true : favoriteTracks.length === 0) && (
          <div className="emptyState emptyState--tall">
            <EmptyArt name="discovery" />
            <p className="emptyState__text">
              {quiet
                ? 'Play a few songs and this page starts learning what you like.'
                : 'Add music to your library and your mixes will appear here.'}
            </p>
          </div>
        )}
        </>
      )}

      {openMix && (
        <PlaylistModal
          open
          onClose={() => setOpenMix(null)}
          title={openMix.title}
          tracks={openMix.tracks}
          emptyLabel="This mix came up empty."
          emptyArt="search"
          // Fork-on-edit: the curator's list stays the curator's and keeps
          // regenerating; saving takes a frozen copy that is yours to edit.
          onSaveCopy={() => {
            void createPlaylist(
              openMix.title,
              openMix.tracks.map((t) => t.path),
            );
            setOpenMix(null);
          }}
          onPlay={(t) => onPlay(t, openMix.tracks)}
          onOpenArtist={(artist) => {
            // Close the sheet first so the artist page is not buried under it.
            setOpenMix(null);
            onOpenArtist(artist);
          }}
        />
      )}
    </div>
  );
}
