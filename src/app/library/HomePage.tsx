import { Button, Pill, SearchField, Text } from '@glacier/react';
import { ChartNoAxesColumn, SlidersHorizontal } from '@glacier/icons';
import { useMemo, useRef, useState } from 'react';
import { useLibrary } from './library.tsx';
import { openMix } from '../nav/openMix.ts';
import { useRippleWave } from '../ux/rippleWave.ts';
import { usePlaylists } from '../playlists/playlists.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { filterTracks } from '../search/trackSearch.ts';
import { ShelfSkeleton } from '../ux/ShelfSkeleton.tsx';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { isMusicImportLink } from '../../plugins/importsBridge.ts';
import { usePlugins } from '../../plugins/runtime.tsx';
import type { Track } from '../core/tauri.ts';
import { ImportFromSearch } from '../search/ImportFromSearch.tsx';
import {
  AlbumCard,
  ArtistCard,
  MixCover,
  Shelf,
  TrackCard,
  greetingFor,
  mixArt,
} from '../home/homeCards.tsx';
import { useHomeFeed } from '../home/useHomeFeed.ts';

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
 *
 * The card atoms and shelf frame live in ../home/homeCards.tsx, the feed
 * machinery in ../home/useHomeFeed.ts; this file keeps the orchestrator and
 * the CuratorShelves/HistoryShelves wrappers.
 */

export function HomePage({
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenStats,
  onTune,
  embedded = false,
  section = 'all',
}: {
  /** Called with the opened track and the shelf it came from as the queue. */
  onPlay: (track: Track, queue: Track[]) => void;
  /** Opens an artist's page - the Top artists shelf links through here. */
  onOpenArtist: (artist: string) => void;
  /** Opens a record. A cover is a door; the page it opens leads with Play. */
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  /** Opens the stats page - the Top artists shelf's header door. */
  onOpenStats?: () => void;
  /** When set, each mix card grows a small tune button - the Booth's door
   *  into trait-weighted rebuilding of that mix. Home passes nothing. */
  onTune?: (mix: { title: string; tracks: Track[] }) => void;
  /** Rendered inside another page (the Library tab): drop the greeting and the
   *  page's own search field - the host carries both - and show just the
   *  personalized shelves, so the mixes fold into Library above what you own. */
  embedded?: boolean;
  /**
   * Which half of these shelves to draw. The two halves answer different
   * questions and now live on different pages: what the AI MADE for you
   * ('curator', on Discover) and what you have been PLAYING ('history', on
   * Library). One component still owns both because the two never render at
   * once - Library and Discover are separate tabs - so splitting the file would
   * duplicate the whole feed-loading half for no gain. Prefer the named
   * wrappers below to passing this by hand.
   */
  section?: 'curator' | 'history' | 'all';
}) {
  const showCurator = section === 'curator' || section === 'all';
  const showHistory = section === 'history' || section === 'all';
  const { tracks, favoriteTracks } = useLibrary();
  const { session } = useServerSession();
  // The entrance wave, when this page stands alone; embedded, the Library
  // page's own observer covers these shelves (first registration wins).
  const [rippleRoot, setRippleRoot] = useState<HTMLDivElement | null>(null);
  useRippleWave(rippleRoot);

  const {
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
  } = useHomeFeed(tracks, session);

  // The home search filters the local library in place: while it holds a query
  // the shelves stand aside and the matches take the page.
  const [query, setQuery] = useState('');

  const hour = new Date().getHours();
  const name = session?.username;

  // A pasted link is an instruction, not a search term: no library contains
  // the text of a URL, so running it as a query could only ever answer "no
  // results" underneath the import that is already happening.
  const searching = query.trim().length > 0 && !isMusicImportLink(query);
  const results = useMemo(
    () => (searching ? filterTracks(tracks, query) : []),
    [searching, tracks, query],
  );

  return (
    <div className={embedded ? 'homeMixes' : 'homePage'} ref={setRippleRoot}>
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

      {showCurator && (skelCurator || skelFeed ? (
        <ShelfSkeleton title="Made from your library" kind="mix" count={4} />
      ) : (
      <Shelf title="Made from your library" count={madeForYou.length}>
        {madeForYou.map(({ mix, curated: fromCurator }) => (
          <button key={mix.id} type="button" className="mixCard" onClick={() => openMix(mix.title, mix.tracks, 'This mix came up empty.')}>
            {/* No AI badge any more: these live on Discover now, which is the
                AI's own page end to end, so a pill on every card said nothing
                the heading did not already say. */}
            <span className="mixCardCoverWrap">
              <MixCover
                tracks={mix.tracks}
                art={mixArt(
                  mix.title,
                  fromCurator ? { id: mix.id, curated: true } : { id: mix.id, flavor: mix.flavor },
                )}
              />
            </span>
            <span className="mixCardTitle">{mix.title}</span>
            <span className="mixCardBlurb">{mix.blurb}</span>
            {/* A span wearing a button's role: the card is already a button,
                and HTML does not allow one inside another. */}
            {onTune && mix.tracks.length > 0 && (
              <span
                role="button"
                tabIndex={0}
                className="mixCard__tune"
                aria-label={`Tune ${mix.title}`}
                title="Rebuild this mix by its traits"
                onClick={(e) => {
                  e.stopPropagation();
                  onTune(mix);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    e.stopPropagation();
                    onTune(mix);
                  }
                }}
              >
                <SlidersHorizontal size={14} />
              </span>
            )}
          </button>
        ))}
      </Shelf>
      ))}

      {/* While the curator is still reading the library, say so plainly with
          the count - a shelf that is thin because the work is half done should
          not look like a shelf that is thin because you have no taste. */}
      {/* Optional chaining, not just a null check: this can arrive from a
          cache written by an older shape (or a server mid-upgrade), and a
          feed that is merely INCOMPLETE must not take the whole page down. */}
      {/* Why the shelf above is thin, in plain numbers - half-done work should
          not read as "you have no taste". Sits under the shelf it explains. */}
      {showCurator &&
        curator?.progress &&
        curator.progress.checked < curator.progress.total && (
          <p className="curatorNote">
            Still reading your library — {curator.progress.checked} of {curator.progress.total}{' '}
            songs.
          </p>
        )}

      {showHistory && (skelFeed ? (
        <ShelfSkeleton title="Jump back in" kind="track" />
      ) : (
      <Shelf title="Jump back in" count={jumpBack.length}>
        {jumpBack.map((album) => (
          <AlbumCard
            key={album[0]!.path}
            track={album[0]!}
            tracks={album}
            onPlay={onPlay}
            onOpenArtist={onOpenArtist}
            onOpen={() =>
              onOpenAlbum
                ? onOpenAlbum(album[0]!.album, album[0]!.albumArtist || album[0]!.artist)
                : onPlay(album[0]!, album)
            }
          />
        ))}
      </Shelf>
      ))}

      {showHistory && (skelFeed ? (
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
      ))}

      {showHistory && (skelFeed ? (
        <ShelfSkeleton title="Recently played" kind="track" />
      ) : (
      <Shelf title="Recently played" count={recent.length}>
        {recent.map((t) => (
          <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, recent)} />
        ))}
      </Shelf>
      ))}

      {/* Three shelves used to sit here and every one of them was a SECOND
          copy of something already on this same screen: "Heavy rotation" is the
          On repeat chip's own list, "New in your library" is the library's
          "Recently added", and "Liked" is its "Liked songs". Scrolling past the
          same music three times under three names is most of why the page read
          as long and confusing - so the duplicates go and the originals, which
          have real destinations behind them, stay. */}

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

    </div>
  );
}

/**
 * The AI's own shelves - the mixes built from your library and your listening -
 * for the Discover page. Everything on Discover is the AI talking, so these
 * carry no badges and no explanation of which process made them.
 */
export function CuratorShelves(props: {
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onTune?: (mix: { title: string; tracks: Track[] }) => void;
}) {
  return <HomePage {...props} embedded section="curator" />;
}

/**
 * The shelves built from what you have PLAYED - jump back in, your top
 * artists, recently played - for the Library page, beside the music you own.
 * Keeps the desktop's only door to the Stats page (the top-artists header).
 */
export function HistoryShelves(props: {
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  onOpenStats?: () => void;
}) {
  return <HomePage {...props} embedded section="history" />;
}
