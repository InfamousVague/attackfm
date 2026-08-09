import { Pill, ScrollArea, SearchField, Text } from '@glacier/react';
import { Sparkles } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { fetchHome, trackIdFromPath, type HomeFeed } from './server.ts';
import { filterTracks } from './trackSearch.ts';
import { PlaylistModal } from './PlaylistModal.tsx';
import { PluginSlot } from '../plugins/runtime.tsx';
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
  const [feed, setFeed] = useState<HomeFeed | null>(null);
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
      setFeed(await fetchHome(s));
    } catch {
      // Unreachable right now; whatever is on screen stays.
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
        {/* The page's own actions, top-right: the importer's queue button when
            that plugin is running, and whatever else a plugin contributes. */}
        <div className="pageActions">
          <PluginSlot id="titlebar-end" />
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
          <p className="homeResultsEmpty">No songs in your library match “{query.trim()}”.</p>
        )
      ) : (
        <>
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

      <Shelf title="Jump back in" count={jumpBack.length}>
        {jumpBack.map((album) => (
          <AlbumCard
            key={album[0]!.path}
            track={album[0]!}
            onOpen={() => onPlay(album[0]!, album)}
          />
        ))}
      </Shelf>

      <Shelf title="Your top artists" count={topArtists.length}>
        {topArtists.map((a) => (
          <ArtistCard key={a.name} name={a.name} cover={a.cover} onOpen={() => onOpenArtist(a.name)} />
        ))}
      </Shelf>

      <Shelf title="Recently played" count={recent.length}>
        {recent.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, recent)} />
        ))}
      </Shelf>

      <Shelf title="Heavy rotation" count={heavy.length}>
        {heavy.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, heavy)} />
        ))}
      </Shelf>

      <Shelf title="New in your library" count={fresh.length}>
        {fresh.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, fresh)} />
        ))}
      </Shelf>

      <Shelf title="Liked" count={feed ? 0 : favoriteTracks.length}>
        {favoriteTracks.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, favoriteTracks)} />
        ))}
      </Shelf>
        </>
      )}

      {openMix && (
        <PlaylistModal
          open
          onClose={() => setOpenMix(null)}
          title={openMix.title}
          tracks={openMix.tracks}
          emptyLabel="This mix came up empty."
          onPlay={(t) => onPlay(t, openMix.tracks)}
        />
      )}
    </div>
  );
}
