import { Pill, ScrollArea, SearchField, Spinner, Text } from '@glacier/react';
import { Play, Plus, Sparkles, X } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import {
  dismissDiscovery,
  fetchCurator,
  fetchDiscoveries,
  fetchHome,
  trackIdFromPath,
  type CuratorFeed,
  type Discovery,
  type DiscoveryFeed,
  type HomeFeed,
} from './server.ts';
import { filterTracks } from './trackSearch.ts';
import { readFeedCache, writeFeedCache } from './feedCache.ts';
import { ShelfSkeleton } from './ShelfSkeleton.tsx';
import { PlaylistModal } from './PlaylistModal.tsx';
import { useAcquire } from '../plugins/runtime.tsx';
import { EmptyArt } from './EmptyArt.tsx';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

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

/** One square track card on a shelf. */
function TrackCard({ track, onOpen }: { track: Track; onOpen: () => void }) {
  return (
    <button type="button" className="trackCard" onClick={onOpen}>
      <img className="trackCardArt" src={track.artwork ?? placeholderArt} alt="" loading="lazy" />
      <span className="trackCardTitle">{track.title}</span>
      <span className="trackCardArtist">{track.artist}</span>
    </button>
  );
}

/** An album card: cover over the album name and artist. Jump-back-in wears it. */
function AlbumCard({ track, onOpen }: { track: Track; onOpen: () => void }) {
  return (
    <button type="button" className="trackCard" onClick={onOpen}>
      <img className="trackCardArt" src={track.artwork ?? placeholderArt} alt="" loading="lazy" />
      <span className="trackCardTitle">{track.album || track.title}</span>
      <span className="trackCardArtist">{track.artist}</span>
    </button>
  );
}

/** An artist card: a round cover over the name, linking into the artist page. */
function ArtistCard({ name, cover, onOpen }: { name: string; cover: string | null; onOpen: () => void }) {
  return (
    <button type="button" className="artistCard" onClick={onOpen}>
      <img className="artistCardArt" src={cover ?? placeholderArt} alt="" loading="lazy" />
      <span className="artistCardName">{name}</span>
    </button>
  );
}

/** A mix's cover: the 2x2 mosaic of its first artworks, glyph fallback. */
function MixCover({ tracks }: { tracks: Track[] }) {
  const arts = tracks.map((t) => t.artwork).filter((a): a is string => a !== null).slice(0, 4);
  if (arts.length < 4) {
    return (
      <div className="mixCardCover mixCardCover--glyph" aria-hidden>
        <Sparkles size={28} />
      </div>
    );
  }
  return (
    <div className="mixCardCover" aria-hidden>
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
 * it has nothing - an empty rail is clutter, not information. */
function Shelf({ title, children, count }: { title: string; children: React.ReactNode; count: number }) {
  if (count === 0) return null;
  return (
    <section className="homeShelf">
      <h2 className="homeShelfTitle">{title}</h2>
      <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
        <div className="homeShelfRow">{children}</div>
      </ScrollArea>
    </section>
  );
}

export function HomePage({
  onPlay,
  onOpenArtist,
}: {
  /** Called with the opened track and the shelf it came from as the queue. */
  onPlay: (track: Track, queue: Track[]) => void;
  /** Opens an artist's page - the Top artists shelf links through here. */
  onOpenArtist: (artist: string) => void;
}) {
  const { tracks, favoriteTracks } = useLibrary();
  const { session } = useServerSession();
  const acquire = useAcquire();
  // The import queue, when the importer plugin is on: a Worth-adding card reads
  // its own download's state from here, by the URL it was enqueued with.
  const downloads = useDownloadsOptional();
  // Every feed seeds from the last launch's answer, so the shelves paint at
  // full size on the first frame and the refresh below swaps content in place
  // - the page must never assemble itself in front of the listener twice.
  const [feed, setFeed] = useState<HomeFeed | null>(() => readFeedCache<HomeFeed>(session, 'home'));
  // What the always-running curator has built for this listener, and how far
  // its reading of the library has got. Polled on the same rhythm as the feed.
  const [curator, setCurator] = useState<CuratorFeed | null>(() =>
    readFeedCache<CuratorFeed>(session, 'curator'),
  );
  // Music the curator found OUTSIDE the library, for acquiring.
  const [discoveries, setDiscoveries] = useState<DiscoveryFeed | null>(() =>
    readFeedCache<DiscoveryFeed>(session, 'discoveries'),
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
  // Whether an importer is on, read through a ref so `refresh` can gate the
  // discovery fetch without being rebuilt each time the queue ticks.
  const canImportRef = useRef(false);
  canImportRef.current = downloads !== null;

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
    // Discoveries are music to ACQUIRE. With no importer there is nothing to
    // acquire it with, so the feed is neither fetched nor shown - the app stays
    // entirely between the listener's devices and their own server.
    if (canImportRef.current) {
      try {
        const fresh = await fetchDiscoveries(s);
        setDiscoveries(fresh);
        writeFeedCache(s, 'discoveries', fresh);
      } catch {
        // Older server, or none of these yet.
      }
    } else {
      setDiscoveries(null);
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

  // What the curator found outside the library. Dismissals apply straight
  // away rather than waiting for the next poll - the card is gone the moment
  // you say no.
  const [hidden, setHidden] = useState<string[]>([]);
  // This discovery's import job, matched by the URL it was enqueued with.
  const jobForUrl = (url: string) => downloads?.jobs?.find((j) => j.url === url) ?? null;
  // A finished download STAYS on the shelf as a play button rather than
  // vanishing - tapping it plays the song it just fetched. It only leaves when
  // dismissed, or when the next curator poll drops it (the song is in the
  // library now, so the curator stops suggesting it).
  const found: Discovery[] = (discoveries?.items ?? []).filter((d) => !hidden.includes(d.id));
  const hide = (id: string) => {
    setHidden((prev) => [...prev, id]);
    const s = sessionRef.current;
    if (s) void dismissDiscovery(s, id).catch(() => {});
  };
  const targetFor = (d: Discovery) => ({
    kind: 'track' as const,
    title: d.title,
    artist: d.artist,
    url: d.url,
  });

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

  const searching = query.trim().length > 0;
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
  const skelFound = held || (wantsFeed && downloads !== null && discoveries === null);
  const anySkeleton = skelFeed || skelCurator || skelFound;

  return (
    <div className="homePage">
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
        placeholder="Search your library"
        aria-label="Search your library"
      />

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
      {skelFound ? (
        <ShelfSkeleton title="Worth adding" kind="find" count={6} />
      ) : (
      <Shelf title="Worth adding" count={found.length}>
        {found.map((d) => {
          const job = jobForUrl(d.url);
          const active = job?.state === 'queued' || job?.state === 'downloading';
          const done = job?.state === 'done';
          // The library track the download produced, once the sync has landed
          // it - what a tap plays. Absent for the brief window between the job
          // finishing and the library delta pulling the file in.
          const doneTrack = done
            ? ((job?.trackIds ?? []).map((id) => byId.get(id)).find((t): t is Track => !!t) ?? null)
            : null;
          const playable = doneTrack !== null;
          // "Working" covers both the download and that sync-lag tail, so the
          // card never offers a play button that cannot play yet.
          const working = active || (done && !playable);
          const canAdd = acquire.hasHandlers(targetFor(d));
          return (
            <div key={d.id} className="findCard">
              <button
                type="button"
                className="findCard__body"
                data-done={playable || undefined}
                // Tappable to play once downloaded; to add while idle (a handler
                // must exist); inert while its own download is in flight.
                disabled={working || (!playable && !canAdd)}
                title={
                  playable || canAdd
                    ? undefined
                    : 'No way to add this — enable Music import or Buy in Plugins'
                }
                onClick={() => {
                  if (playable && doneTrack) onPlay(doneTrack, [doneTrack]);
                  else if (!done) acquire.acquire(targetFor(d));
                }}
              >
                <span className="findCard__cover" data-downloading={working || undefined}>
                  {d.cover ? <img src={d.cover} alt="" loading="lazy" /> : <Sparkles size={24} />}
                  {working ? (
                    // The cover dims under a spinner until the file has landed.
                    <span
                      className="findCard__progress"
                      role="status"
                      aria-label={`Downloading ${d.title}`}
                    >
                      <Spinner size="md" />
                    </span>
                  ) : playable ? (
                    // Downloaded: a play glyph, and the tap plays it.
                    <span className="findCard__play" aria-hidden>
                      <Play size={16} fill="currentColor" />
                    </span>
                  ) : (
                    <span className="findCard__add" aria-hidden>
                      <Plus size={16} />
                    </span>
                  )}
                </span>
                <span className="trackCardTitle">{d.title}</span>
                <span className="trackCardArtist">{d.artist}</span>
                {/* Say only what was actually measured - the tempo when a preview
                    was read, the words when lyrics were found. */}
                <span className="findCard__why">
                  {[
                    d.seed ? `like ${d.seed}` : null,
                    d.bpm ? `${Math.round(d.bpm)} BPM` : null,
                    d.lyricsRead ? 'words match' : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </button>
              {/* The dismiss 'x' only while it is still a suggestion; once it is
                  downloaded the card is a play button, not something to refuse. */}
              {!done && (
                <button
                  type="button"
                  className="findCard__no"
                  aria-label={`Not interested in ${d.title}`}
                  onClick={() => hide(d.id)}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          );
        })}
      </Shelf>
      )}

      {skelCurator ? (
        <ShelfSkeleton title="From your curator" kind="mix" count={4} />
      ) : (
      <Shelf title="From your curator" count={curated.length}>
        {curated.map((mix) => (
          <button key={mix.id} type="button" className="mixCard" onClick={() => setOpenMix(mix)}>
            <MixCover tracks={mix.tracks} />
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
            <MixCover tracks={mix.tracks} />
            <span className="mixCardTitle">
              {mix.title}
              {mix.flavor === 'ai' && (
                <Pill size="sm" tone="accent" className="mixCardBadge">
                  AI
                </Pill>
              )}
            </span>
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
      <Shelf title="Your top artists" count={topArtists.length}>
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

      {!anySkeleton &&
        found.length === 0 &&
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
