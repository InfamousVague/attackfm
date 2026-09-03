import { usePrefetchArt } from '../ux/artPrefetch.ts';
import { artSized } from '../server.ts';
import { Button, IconButton, ScrollArea, SegmentedControl, Text } from '@glacier/react';
import { Download, ListMusic, Play, Shuffle } from '@glacier/icons';
import { usePluginPages } from '../../plugins/runtime.tsx';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { useCardArt, mosaicArts } from '../ux/artLoad.ts';
import { CoverWall } from '../playlists/CoverWall.tsx';
import { useWallClips } from './wallClips.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { shuffled } from '../ux/shuffle.ts';
import { useRippleWave } from '../ux/rippleWave.ts';
import { usePlaylists } from '../playlists/playlists.tsx';
import { isFavouriteBook, shelve } from './bookShelf.ts';
import { ShelfSkeleton } from '../ux/ShelfSkeleton.tsx';
import { PlaylistShowcase } from '../playlists/PlaylistShowcase.tsx';
import { HomeStatsCards } from './HomeStatsCards.tsx';
import { TrackMenu } from './TrackMenu.tsx';
import { isDesktopApp } from '../core/platform.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { SongTable } from './SongTable.tsx';
import type { Track } from '../core/tauri.ts';
import placeholderArt from '../../assets/attack-wave.png';

/**
 * The Library tab - the app's home, and ONLY what you saved or made: your
 * playlists, your liked songs, the music you added, the books you kept, and
 * the week's numbers. Everything the machine suggests - the mixes it built,
 * the auditions it fetched, the charts, the shelves it reads from your history
 * - is on Discover, its own tab. That split is by request: this page used to
 * carry all of it and read as four pages in one scroller. Searching lives in
 * the header's search icon (the full-screen sheet), so the page carries no
 * filter field.
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
    <TrackMenu track={track}>
      <button type="button" className="trackCard" onClick={onOpen}>
        <img className="trackCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
        <span className="trackCardTitle" data-loading={idle}>{loaded ? track.title : NBSP}</span>
        <CardArtist artist={track.artist} idle={idle} loaded={loaded} onOpenArtist={onOpenArtist} />
      </button>
    </TrackMenu>
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
    <TrackMenu track={track}>
      <button type="button" className="trackCard" onClick={onOpen}>
        <img className="trackCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
        <span className="trackCardTitle" data-loading={idle}>{loaded ? track.album || track.title : NBSP}</span>
        <CardArtist artist={track.artist} idle={idle} loaded={loaded} onOpenArtist={onOpenArtist} />
      </button>
    </TrackMenu>
  );
}

/**
 * The Music shelf's header - the same hero Books wears, so the two faces of
 * the Library are recognisably one page rather than a dressed shelf and a bare
 * one.
 *
 * The wall behind it is the difference: where Books drifts its sleeves, Music
 * drifts the CANVASES this library already stores - the moving covers Spotify
 * ships with a song, sampled from the sidecars beside your music. They are the
 * one piece of art in the library that is already in motion, so a wall built
 * from them moves twice: the columns drift, and every tile in them plays.
 *
 * It degrades in one step. No clips (a server with no Canvas source, or one
 * that has not stored any yet) and `CoverWall` falls back to the sleeves, which
 * is the header Books has always worn.
 */
function MusicHead({
  tracks,
  onPlay,
}: {
  tracks: Track[];
  onPlay: (track: Track, context?: Track[]) => void;
}) {
  const { session } = useServerSession();
  const clips = useWallClips(session);
  // 640 for the tile you look at, 160 for the wall that is blurred past detail
  // - the wall only gets these when there are no clips to draw instead.
  const covers = useMemo(() => mosaicArts(tracks.map((t) => t.artwork), 4, 640), [tracks]);
  const wallArt = useMemo(() => tracks.map((t) => t.artwork), [tracks]);
  const empty = tracks.length === 0;

  return (
    <header className="playlistHead songPageHead musicHead">
      <CoverWall artworks={wallArt} clips={clips} />
      <div className="playlistHead__cover" aria-hidden>
        {covers.length >= 4 ? (
          <div className="tileSquircle tileLikedGrid playlistHead__mosaic">
            {covers.map((art, i) => (
              <img key={i} src={art} alt="" />
            ))}
          </div>
        ) : (
          <div className="tileSquircle tileRecent playlistHead__mosaic">
            {covers[0] ? <img src={covers[0]} alt="" /> : <ListMusic size={28} />}
          </div>
        )}
      </div>
      <div className="playlistHead__body">
        <Text tone="muted" size="xs" className="playlistHead__kicker">
          Your library
        </Text>
        <h2 className="playlistHead__name">Music</h2>
        <Text tone="muted" size="sm">
          {tracks.length} {tracks.length === 1 ? 'song' : 'songs'}
        </Text>
        <div className="playlistHead__actions">
          <Button
            variant="solid"
            size="sm"
            disabled={empty}
            onClick={() => {
              if (tracks[0]) onPlay(tracks[0], tracks);
            }}
          >
            <Play size={15} fill="currentColor" />
            Play
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={empty}
            onClick={() => {
              const pool = shuffled(tracks);
              if (pool[0]) onPlay(pool[0], pool);
            }}
          >
            <Shuffle size={15} />
            Shuffle
          </Button>
        </div>
      </div>
    </header>
  );
}

export function LibraryView({
  view,
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  onOpenSongs,
  onOpenDownloads,
  onOpenStats,
}: {
  /** Opens the stats page - the mini cards' one destination. */
  onOpenStats?: () => void;
  /** Which face the page wears: the shelves, or every song as one table.
   *  Flipped by the app header's "All" button - the page just renders it. */
  view: 'summary' | 'all';
  onPlay: (track: Track, context?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Opens a record - the "Jump back in" covers are doors. */
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  onOpenPlaylist: (id: string) => void;
  /** Opens a whole-collection song page (Liked, or every song) from a tile. */
  onOpenSongs: (view: import('./SongPage.tsx').SongCollection) => void;
  /** Opens the download queue. Absent when no importer is running, and the
   *  icon goes with it - there is nothing to queue without one. */
  onOpenDownloads?: () => void;
}) {
  const { tracks, favoriteTracks, scanning, books, isFavorite } = useLibrary();
  /*
   * The books you have hearted, as a shelf of their own.
   *
   * Books are held out of `tracks`, so none of the shelves below could ever show
   * one - a hearted book was invisible everywhere except its own page. Grouped
   * into books rather than listed as files: a hearted sectioned reading would
   * otherwise be fifty identical cards.
   */
  const lovedBooks = useMemo(
    () => shelve(books).filter((b) => isFavouriteBook(b, isFavorite)),
    [books, isFavorite],
  );
  const { playlists } = usePlaylists();

  // A library that is empty AT MOUNT is either truly empty or still on its
  // way; hold the page as skeletons so it assembles once, whole, instead of
  // shelf by shelf. A library seeded from cache skips this ENTIRELY - content
  // beats placeholders every time it exists.
  //
  // The hold follows the LIBRARY, not a clock. It used to be a flat one-second
  // timer, which is what flashed "no music in your library yet": the timer
  // expired on its own schedule, and if the sync had not landed by then the
  // page rendered its empty state for a beat before the tracks arrived and
  // replaced it. `scanning` is the honest signal - the library saying it is
  // still fetching AND has nothing to show yet - so the skeletons now stand
  // exactly as long as there is nothing to stand in for.
  // The entrance wave: cards ripple in as they meet the view, each landing
  // with a soft tick - see rippleWave.ts. Watching the page root covers the
  // shelves, the playlist grid, and the embedded Home below all at once.
  const [rippleRoot, setRippleRoot] = useState<HTMLDivElement | null>(null);
  useRippleWave(rippleRoot);

  const emptyAtMount = useRef(tracks.length === 0);
  // The ceiling, so a server that never answers cannot leave the page in
  // skeletons for the rest of the session. Long enough not to fire during any
  // sync that is genuinely working.
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    if (!emptyAtMount.current) return;
    const t = window.setTimeout(() => setGaveUp(true), 15000);
    return () => window.clearTimeout(t);
  }, []);
  const warming = tracks.length === 0 && scanning && !gaveUp;

  // Newest first, the shelf's own play queue.
  const recentlyAdded = useMemo(
    () => [...tracks].sort((a, b) => b.addedAt - a.addedAt).slice(0, 20),
    [tracks],
  );

  /*
   * Warm the shelf covers before they are scrolled to.
   *
   * The shelves draw the 640px variant, and the server BUILDS each size on the
   * first request that asks for it, so an unwarmed shelf pays for a resize as
   * well as a download the moment a card comes into view. The list is the
   * visible top of the page, and it is short - twenty - so warming it is
   * bounded and is exactly the set about to be drawn.
   */
  usePrefetchArt(
    useMemo(() => recentlyAdded.map((t) => artSized(t.artwork, 640)), [recentlyAdded]),
  );

  // Books live here now, behind a toggle at the top of the page rather than a
  // seat of their own in the nav. The books plugin still owns the shelf - so
  // this finds its page and renders it, and the toggle only appears while the
  // plugin is on. Music is the default face; the choice is per session.
  const pluginPages = usePluginPages();
  const booksPage = pluginPages.find((pg) => pg.pluginId === 'books') ?? null;
  const [section, setSection] = useState<'music' | 'books'>('music');
  const active = booksPage ? section : 'music';

  /*
   * The toggle, built once and handed to whichever pane is showing.
   *
   * It sits UNDER the pane's hero: the first row of the page's content, where
   * a section switch reads as a switch rather than as chrome painted on the
   * artwork. It rode on the hero for a while and that cost it twice - it had
   * to be lifted out of the header's flow and given a forehead to sit in, and
   * on the wall it competed with the very covers it was standing on.
   *
   * Below the header there is no notch to dodge either: the slide that pulls
   * a full-bleed hero up behind the title bar (`.appContent:has(.coverWall)`)
   * takes the header with it and leaves everything after it in ordinary flow,
   * which is where this now is. Both panes take it through the same slot, so
   * there is one control and not two to keep in step.
   */
  const toggle = booksPage ? (
    <div className="libraryToggle">
      <SegmentedControl
        aria-label="Library section"
        fullWidth
        options={[
          { value: 'music', label: 'Music' },
          { value: 'books', label: 'Books' },
        ]}
        value={active}
        onValueChange={(v) => setSection(v === 'books' ? 'books' : 'music')}
      />
    </div>
  ) : null;

  return (
    <div className="libraryHost">
      {active === 'books' && booksPage ? (
        booksPage.render({
          onPlay,
          onOpenArtist,
          onOpenPlaylist,
          onOpenSongs,
          headerSlot: toggle,
        })
      ) : (
    <div className="homePage libraryPage" ref={setRippleRoot}>
      {/* The hero, and the page's first child on purpose: `.appContent:has(
          .coverWall)` slides the whole scroller up behind the title bar, so the
          wall runs to the top of the screen and under the glass. Anything above
          it here would be dragged under the bar with it. */}
      <MusicHead tracks={tracks} onPlay={onPlay} />
      {toggle}
      {/* No search field here: Search is its own page now (and its own seat in
          the nav), so a second box on this one asked the same question twice
          and answered it in a smaller room. */}
      {/* The desktop's copy of the action row. Everywhere else these two live
          in the app header (see App.tsx) - but the desktop has no such header,
          it has a title bar and a rail, so the page keeps them. */}
      {isDesktopApp && (
        <div className="libraryActions">
          {onOpenDownloads && (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Downloads"
              title="Downloads"
              onClick={onOpenDownloads}
            >
              <Download size={18} />
            </IconButton>
          )}
        </div>
      )}
      {view === 'summary' && warming ? (
        <>
          {/* The first-launch skeleton pass: every surface the page will hold,
              at its real size, for a beat - so the library assembles once. */}
          <ShelfSkeleton title="Playlists" kind="tile" count={8} />
          <ShelfSkeleton title="Recently added" kind="track" />
          <ShelfSkeleton title="Liked songs" kind="track" />
        </>
      ) : view === 'summary' ? (
        <>
          {/* Playlists lead the shelves: making and managing lists is the
              library's working surface, so it sits where the thumb lands
              first, above the read-only shelves. */}
          <PlaylistShowcase
            onPlay={onPlay}
            onOpenPlaylist={onOpenPlaylist}
            onOpenArtist={onOpenArtist}
            onOpenSongs={onOpenSongs}
          />

          {/* Under the playlists, because both are "things you chose" - a list
              you built and a book you kept. Renders nothing until a book is
              hearted. (The curator's mixes, the collector's auditions and the
              new-music shelf used to sit between the two; they are Discover's
              now - this page is what you chose, and nothing the machine did.) */}
          <Shelf title="Books you love" count={lovedBooks.length}>
            {lovedBooks.map((book) => (
              <button
                key={book.key}
                type="button"
                className="trackCard"
                onClick={() => {
                  const [first] = book.tracks;
                  // The whole book is the queue; the player's own restore puts
                  // the needle back where this one was left.
                  if (first) onPlay(first, book.tracks);
                }}
              >
                {book.cover ? (
                  <img className="trackCardArt artPop" src={book.cover} alt="" loading="lazy" />
                ) : (
                  <span className="trackCardArt" aria-hidden />
                )}
                <span className="trackCardTitle">{book.title}</span>
                <span className="trackCardArtist">{book.author}</span>
              </button>
            ))}
          </Shelf>

          {/* This week's listening at a glance, linking into the full page.
              Renders nothing until there is a week to speak of. */}
          {onOpenStats && <HomeStatsCards onOpenStats={onOpenStats} />}

          {recentlyAdded.length === 0 && favoriteTracks.length === 0 && (
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
          {/* No Artists or Albums shelves: those were the library browsing
              itself, and by request this page holds what you saved or made.
              An artist is a search or a tap on a credit away. */}
        </>
      ) : (
        <section className="homeShelf librarySongs">
          <div className="libraryBody">
            <SongTable onPlay={onPlay} onOpenArtist={onOpenArtist} tracks={tracks} />
          </div>
        </section>
      )}
    </div>
      )}
    </div>
  );
}
