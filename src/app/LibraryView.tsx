import { ScrollArea } from '@glacier/react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { usePlaylists } from './playlists.tsx';
import { ShelfSkeleton } from './ShelfSkeleton.tsx';
import { PlaylistShowcase } from './PlaylistShowcase.tsx';
import { HomePage } from './HomePage.tsx';
import { EmptyArt } from './EmptyArt.tsx';
import { SongTable } from './SongTable.tsx';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

/**
 * The Library tab - now the app's home. It focuses on what you HAVE: a
 * summary of horizontal shelves built entirely from the local library, or the
 * full song table, chosen by a tab at the top. Searching lives in the header's
 * search icon (the full-screen sheet), so the page carries no filter field.
 */

/** A shelf: a heading over a horizontal run of cards. Renders nothing when it
 *  has nothing - an empty rail is clutter, not information. */
function Shelf({ title, count, children }: { title: string; count: number; children: ReactNode }) {
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

/** Blank line the skeleton holds so the card keeps its exact height. */
const NBSP = ' ';

/**
 * A card's artwork, resolving. Returns the src to draw and whether it has
 * arrived - the card shows a shimmer over the art and its text until then, so
 * covers fade in together instead of popping and shoving the row as they
 * trickle over the network. Revealed on the image's load; a bad URL falls back
 * to the placeholder once; and a safety timeout reveals a hung request rather
 * than shimmering forever.
 */
function useCardArt(artwork: string | null): {
  src: string;
  loaded: boolean;
  onLoad: () => void;
  onError: () => void;
} {
  const wanted = artwork ?? placeholderArt;
  const [src, setSrc] = useState(wanted);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setSrc(wanted);
    setLoaded(false);
    const timer = window.setTimeout(() => setLoaded(true), 20000);
    return () => window.clearTimeout(timer);
  }, [wanted]);
  return {
    src,
    loaded,
    onLoad: () => setLoaded(true),
    // A dead cover URL swaps to the placeholder once (which then loads and
    // reveals); if the placeholder itself is what failed, just reveal.
    onError: () => {
      if (src === placeholderArt) setLoaded(true);
      else setSrc(placeholderArt);
    },
  };
}

/** The artist line on a card: tappable into the artist's page when a handler
 *  is given. A span wearing link manners, because the card around it is
 *  already a button and the tap must not also fire the card. */
function CardArtist({
  artist,
  idle,
  loaded,
  onOpenArtist,
}: {
  artist: string;
  idle: true | undefined;
  loaded: boolean;
  onOpenArtist?: (artist: string) => void;
}) {
  if (!onOpenArtist || !loaded) {
    return (
      <span className="trackCardArtist" data-loading={idle}>
        {loaded ? artist : NBSP}
      </span>
    );
  }
  return (
    <span
      role="link"
      tabIndex={0}
      className="trackCardArtist cardArtistLink"
      onClick={(e) => {
        e.stopPropagation();
        onOpenArtist(artist);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          onOpenArtist(artist);
        }
      }}
    >
      {artist}
    </span>
  );
}

/** A square song card: cover over title + artist. */
function TrackCard({
  track,
  onOpen,
  onOpenArtist,
}: {
  track: Track;
  onOpen: () => void;
  onOpenArtist?: (artist: string) => void;
}) {
  const { src, loaded, onLoad, onError } = useCardArt(track.artwork);
  const idle = !loaded || undefined;
  return (
    <button type="button" className="trackCard" onClick={onOpen}>
      <img className="trackCardArt" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
      <span className="trackCardTitle" data-loading={idle}>{loaded ? track.title : NBSP}</span>
      <CardArtist artist={track.artist} idle={idle} loaded={loaded} onOpenArtist={onOpenArtist} />
    </button>
  );
}

/** A square album card: cover over the album name and artist. */
function AlbumCard({
  track,
  onOpen,
  onOpenArtist,
}: {
  track: Track;
  onOpen: () => void;
  onOpenArtist?: (artist: string) => void;
}) {
  const { src, loaded, onLoad, onError } = useCardArt(track.artwork);
  const idle = !loaded || undefined;
  return (
    <button type="button" className="trackCard" onClick={onOpen}>
      <img className="trackCardArt" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
      <span className="trackCardTitle" data-loading={idle}>{loaded ? track.album || track.title : NBSP}</span>
      <CardArtist artist={track.artist} idle={idle} loaded={loaded} onOpenArtist={onOpenArtist} />
    </button>
  );
}

/** A round artist card that links into the artist page. */
function ArtistCard({ name, cover, onOpen }: { name: string; cover: string | null; onOpen: () => void }) {
  const { src, loaded, onLoad, onError } = useCardArt(cover);
  const idle = !loaded || undefined;
  return (
    <button type="button" className="artistCard" onClick={onOpen}>
      <img className="artistCardArt" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
      <span className="artistCardName" data-loading={idle}>{loaded ? name : NBSP}</span>
    </button>
  );
}

export function LibraryView({
  view,
  onPlay,
  onOpenArtist,
  onOpenPlaylist,
}: {
  /** Which face the page wears: the shelves, or every song as one table.
   *  Flipped by the app header's "All" button - the page just renders it. */
  view: 'summary' | 'all';
  onPlay: (track: Track, context?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenPlaylist: (id: string) => void;
}) {
  const { tracks, favoriteTracks } = useLibrary();
  const { playlists } = usePlaylists();

  // A library that is empty AT MOUNT is either truly empty or still on its
  // way; hold the page as skeletons for a beat so it assembles once, whole,
  // instead of shelf by shelf. A library seeded from cache skips this ENTIRELY
  // - content beats placeholders every time it exists.
  const emptyAtMount = useRef(tracks.length === 0);
  const [held, setHeld] = useState(emptyAtMount.current);
  useEffect(() => {
    if (!held) return;
    const t = window.setTimeout(() => setHeld(false), 1000);
    return () => window.clearTimeout(t);
  }, [held]);
  const warming = held;

  // Newest first, the shelf's own play queue.
  const recentlyAdded = useMemo(
    () => [...tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 20),
    [tracks],
  );

  // Artists by how much of them the library holds, each wearing its first cover.
  const artists = useMemo(() => {
    const map = new Map<string, { name: string; cover: string | null; count: number }>();
    for (const t of tracks) {
      const name = t.artist.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const entry = map.get(key);
      if (entry) {
        entry.count += 1;
        if (!entry.cover) entry.cover = t.artwork;
      } else {
        map.set(key, { name, cover: t.artwork, count: 1 });
      }
    }
    return [...map.values()].sort((a, b) => b.count - a.count).slice(0, 20);
  }, [tracks]);

  // Albums, newest arrival first, each a representative track for play-through.
  const albums = useMemo(() => {
    const map = new Map<string, Track[]>();
    for (const t of tracks) {
      if (!t.album.trim()) continue;
      const key = `${t.artist.trim().toLowerCase()}${t.album.trim().toLowerCase()}`;
      const list = map.get(key);
      if (list) list.push(t);
      else map.set(key, [t]);
    }
    return [...map.entries()]
      .map(([key, list]) => ({ key, list, latest: Math.max(...list.map((t) => t.addedAt)) }))
      .sort((a, b) => b.latest - a.latest)
      .slice(0, 20);
  }, [tracks]);

  return (
    <div className="homePage libraryPage">
      {view === 'summary' && warming ? (
        <>
          {/* The first-launch skeleton pass: every surface the page will hold,
              at its real size, for a beat - so the library assembles once. */}
          <ShelfSkeleton title="Playlists" kind="tile" count={8} />
          <ShelfSkeleton title="Recently added" kind="track" />
          <ShelfSkeleton title="Liked songs" kind="track" />
          <ShelfSkeleton title="Artists" kind="artist" />
          <ShelfSkeleton title="Albums" kind="track" />
        </>
      ) : view === 'summary' ? (
        <>
          {/* Playlists lead the shelves: making and managing lists is the
              library's working surface, so it sits where the thumb lands
              first, above the read-only shelves. */}
          <PlaylistShowcase onPlay={onPlay} onOpenPlaylist={onOpenPlaylist} onOpenArtist={onOpenArtist} />

          {/* The personalized mixes, folded in from the old Home: what the
              server made from your listening. They sit BELOW the stats and the
              playlists now - the page should open on your own library, not on
              a shelf that is empty until a history exists. Renders its own
              shelves and skeletons, and nothing at all on a local library. */}
          <HomePage embedded onPlay={onPlay} onOpenArtist={onOpenArtist} />

          {recentlyAdded.length === 0 &&
            favoriteTracks.length === 0 &&
            artists.length === 0 &&
            albums.length === 0 && (
              <div className="emptyState emptyState--tall">
                <EmptyArt name="library" />
                <p className="emptyState__text">
                  No music in your library yet. Sign in to your server or import songs to fill it.
                </p>
              </div>
            )}

          <Shelf title="Recently added" count={recentlyAdded.length}>
            {recentlyAdded.map((t) => (
              <AlbumCard key={t.path} track={t} onOpen={() => onPlay(t, recentlyAdded)} onOpenArtist={onOpenArtist} />
            ))}
          </Shelf>

          <Shelf title="Liked songs" count={favoriteTracks.length}>
            {favoriteTracks.slice(0, 20).map((t) => (
              <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, favoriteTracks)} onOpenArtist={onOpenArtist} />
            ))}
          </Shelf>

          <Shelf title="Artists" count={artists.length}>
            {artists.map((a) => (
              <ArtistCard key={a.name} name={a.name} cover={a.cover} onOpen={() => onOpenArtist(a.name)} />
            ))}
          </Shelf>

          <Shelf title="Albums" count={albums.length}>
            {albums.map((g) => (
              <AlbumCard key={g.key} track={g.list[0]!} onOpen={() => onPlay(g.list[0]!, g.list)} onOpenArtist={onOpenArtist} />
            ))}
          </Shelf>
        </>
      ) : (
        <section className="homeShelf librarySongs">
          <div className="libraryBody">
            <SongTable onPlay={onPlay} onOpenArtist={onOpenArtist} tracks={tracks} />
          </div>
        </section>
      )}
    </div>
  );
}
