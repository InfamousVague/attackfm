import { ContextMenu, MenuItem } from '@glacier/react';
import { ListEnd, ListStart, Play, Shuffle } from '@glacier/icons';
import { useQueueControls } from '../player/queueControls.tsx';
import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { Button, SearchField, Text } from '@glacier/react';
import { ChartNoAxesColumn, SlidersHorizontal } from '@glacier/icons';
import { useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { openMix } from '../nav/openMix.ts';
import { useRippleWave } from '../ux/rippleWave.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { filterTracks } from '../search/trackSearch.ts';
import { ShelfSkeleton } from '../ux/ShelfSkeleton.tsx';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { isMusicImportLink } from '../../plugins/importsBridge.ts';
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
import { useHomeFeed, type HomeFeedValue } from '../home/useHomeFeed.ts';
import { useDiscoverFeedOptional } from '../home/DiscoverFeed.tsx';

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
 * machinery in ../home/useHomeFeed.ts. The shelves themselves are
 * `HomeShelves`, which takes the feed as a PROP: the Discover page fetches
 * once (home/DiscoverFeed.tsx) and hands the same answer to its curator half
 * and its history half, where each used to run its own copy of the fetch.
 * `HomePage` is the standalone reading, which fetches for itself.
 */

/** How many cards a rail shows. Fewer things, bigger: a rail is a glance,
 *  and the page it sits on opens the whole list one tap away. */
const RAIL = 6;

/**
 * Which shelves a rendering draws. The curator's half splits in two because
 * Discover wants "Made for you" at the top of the page and "Made from your
 * library" / "Your stations" a long way below it, with the world's shelves
 * in between:
 *   'madeForYou' - the daylist and the daily/mood mixes;
 *   'library'    - made from your library, the stations, the curator's note;
 *   'curator'    - both of those together (the Booth mounts this);
 *   'history'    - jump back in, top artists, recently played;
 *   'all'        - everything, for the standalone page.
 */
export type ShelfSection = 'madeForYou' | 'library' | 'curator' | 'history' | 'all';

/** A curated list or mix as a tile carries it. */
interface MixLike {
  id: string;
  title: string;
  blurb: string;
  tracks: Track[];
}

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
  /** Rendered inside another page: drop the greeting and the page's own
   *  search field - the host carries both - and show just the shelves. */
  embedded?: boolean;
  /** Which shelves to draw - see `ShelfSection`. */
  section?: ShelfSection;
}) {
  const { tracks, forYou } = useLibrary();
  const { session } = useServerSession();
  const feed = useHomeFeed(tracks, session, forYou);
  return (
    <HomeShelves
      feed={feed}
      onPlay={onPlay}
      onOpenArtist={onOpenArtist}
      onOpenAlbum={onOpenAlbum}
      onOpenStats={onOpenStats}
      onTune={onTune}
      embedded={embedded}
      section={section}
    />
  );
}

/**
 * One mix as a tile: the cover mosaic over a title and a blurb, with the
 * held verbs every song menu carries. The four shelves that draw one used to
 * carry four copies of this markup; the feature variant (the first card of a
 * rail, two cards wide with its name over the art) is why they are one now.
 */
function MixTile({
  mix,
  art,
  feature = false,
  verbs,
  emptyLabel,
  onPlay,
  onTune,
}: {
  mix: MixLike;
  art: { src: string; hue: number } | null;
  /** The rail's lead: two cards wide, 16:10, the words over a scrim. */
  feature?: boolean;
  /** 'play' carries Play and Shuffle on the face; 'queue' keeps only the
   *  queue verbs (a daylist or a station plays from its own page). */
  verbs: 'play' | 'queue';
  emptyLabel: string;
  onPlay: (track: Track, queue: Track[]) => void;
  onTune?: (mix: { title: string; tracks: Track[] }) => void;
}) {
  const { playNext, addToQueue } = useQueueControls();
  const mixHold = useHoldToMenu((from) => from.closest('.mixCardMenuTarget'));
  return (
    <ContextMenu
      {...mixHold}
      aria-label={`${mix.title} actions`}
      className="mixCardMenuTarget"
      content={
        <>
          {verbs === 'play' && (
            <>
              <MenuItem
                icon={<Play size={15} />}
                onSelect={() => mix.tracks.length > 0 && onPlay(mix.tracks[0]!, mix.tracks)}
              >
                Play
              </MenuItem>
              <MenuItem
                icon={<Shuffle size={15} />}
                onSelect={() => {
                  const order = [...mix.tracks].sort(() => Math.random() - 0.5);
                  if (order.length > 0) onPlay(order[0]!, order);
                }}
              >
                Shuffle
              </MenuItem>
            </>
          )}
          <MenuItem
            icon={<ListStart size={15} />}
            onSelect={() => [...mix.tracks].reverse().forEach((t) => playNext(t))}
          >
            Play next
          </MenuItem>
          <MenuItem icon={<ListEnd size={15} />} onSelect={() => mix.tracks.forEach((t) => addToQueue(t))}>
            Add to queue
          </MenuItem>
        </>
      }
    >
      <button
        type="button"
        className={feature ? 'mixCard mixCard--feature' : 'mixCard'}
        onClick={() => openMix(mix.title, mix.tracks, emptyLabel)}
      >
        <span className="mixCardCoverWrap">
          <MixCover tracks={mix.tracks} art={art} />
        </span>
        <span className="mixCardText">
          <span className="mixCardTitle">{mix.title}</span>
          <span className="mixCardBlurb">{mix.blurb}</span>
        </span>
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
    </ContextMenu>
  );
}

export function HomeShelves({
  feed,
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenStats,
  onTune,
  embedded = false,
  section = 'all',
  daylistTaken = false,
}: {
  feed: HomeFeedValue;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  onOpenStats?: () => void;
  onTune?: (mix: { title: string; tracks: Track[] }) => void;
  embedded?: boolean;
  section?: ShelfSection;
  /** The Discover hero is wearing the daylist, so the shelf must not show it
   *  a second time an inch below. */
  daylistTaken?: boolean;
}) {
  const showMadeForYou = section === 'madeForYou' || section === 'curator' || section === 'all';
  const showLibrary = section === 'library' || section === 'curator' || section === 'all';
  const showHistory = section === 'history' || section === 'all';
  const { tracks, favoriteTracks } = useLibrary();
  const { session } = useServerSession();
  // The entrance wave, when this page stands alone; embedded, the host
  // page's own observer covers these shelves (first registration wins).
  const [rippleRoot, setRippleRoot] = useState<HTMLDivElement | null>(null);
  useRippleWave(rippleRoot);

  const {
    feed: home,
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
  } = feed;

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

  // "Made for you": the daylist leads when the hero has not taken it - the
  // one card that moves with the clock is the most "for you, now" thing the
  // curator makes - then the numbered Daily Mixes, the mood mixes and the
  // activity mixes. The first card is the feature, two wide.
  const madeForYouRail = useMemo(() => {
    const out: { mix: MixLike; verbs: 'play' | 'queue' }[] = [];
    if (daylist && !daylistTaken) {
      out.push({ mix: { ...daylist, title: daylist.subtitle }, verbs: 'queue' });
    }
    for (const mix of madeForYouShelf) out.push({ mix, verbs: 'play' });
    return out.slice(0, RAIL);
  }, [daylist, daylistTaken, madeForYouShelf]);

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
                  : home?.ai
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
          {/* "Made for you": the daylist, the numbered Daily Mixes, the ai-vibe
              mood mixes and the audio-character activity mixes, as one shelf.
              Its first card is the feature: two wide, the words over the
              art - the page's biggest owned thing after the hero. */}
          {showMadeForYou && !skelCurator && madeForYouRail.length > 0 && (
            <Shelf title="Made for you" count={madeForYouRail.length}>
              {madeForYouRail.map(({ mix, verbs }, i) => (
                <MixTile
                  key={mix.id}
                  mix={mix}
                  art={mixArt(mix.title, { id: mix.id, curated: true })}
                  feature={i === 0}
                  verbs={verbs}
                  emptyLabel="This mix came up empty."
                  onPlay={onPlay}
                />
              ))}
            </Shelf>
          )}

          {showLibrary &&
            (skelCurator || skelFeed ? (
              <ShelfSkeleton title="Made from your library" kind="mix" count={4} />
            ) : (
              <Shelf title="Made from your library" count={Math.min(madeForYou.length, RAIL)}>
                {/* No AI badge: these live on Discover, which is the AI's own
                    page end to end, so a pill on every card said nothing the
                    heading did not already say. */}
                {madeForYou.slice(0, RAIL).map(({ mix, curated: fromCurator }) => (
                  <MixTile
                    key={mix.id}
                    mix={mix}
                    art={mixArt(
                      mix.title,
                      fromCurator ? { id: mix.id, curated: true } : { id: mix.id, flavor: mix.flavor },
                    )}
                    verbs="play"
                    emptyLabel="This mix came up empty."
                    onPlay={onPlay}
                    onTune={onTune}
                  />
                ))}
              </Shelf>
            ))}

          {/*
           * The stations, as their own shelf. They live in the same curated
           * table as the mixes above - that is what makes them playable with
           * no new contract - but a station is a different promise: a mix is
           * your own music arranged, a station also plays you things you have
           * never heard. Folded into the shelf above they were invisible, and
           * with the Booth behind developer mode, this shelf on Discover is
           * the one place a person meets them.
           */}
          {showLibrary && !skelCurator && stations.length > 0 && (
            <Shelf title="Your stations" count={Math.min(stations.length, RAIL)}>
              {stations.slice(0, RAIL).map((mix) => (
                <MixTile
                  key={mix.id}
                  mix={mix}
                  art={mixArt(mix.title, { id: mix.id, curated: true })}
                  verbs="queue"
                  emptyLabel="This station came up empty."
                  onPlay={onPlay}
                />
              ))}
            </Shelf>
          )}

          {/* Why the shelf above is thin, in plain numbers - half-done work
              should not read as "you have no taste". Optional chaining because
              this can arrive from a cache written by an older shape, and a
              feed that is merely INCOMPLETE must not take the page down. */}
          {showLibrary &&
            curator?.progress &&
            curator.progress.checked < curator.progress.total && (
              <p className="curatorNote">
                Still reading your library — {curator.progress.checked} of {curator.progress.total}{' '}
                songs.
              </p>
            )}

          {showHistory &&
            (skelFeed ? (
              <ShelfSkeleton title="Jump back in" kind="track" count={RAIL} />
            ) : (
              <Shelf title="Jump back in" count={Math.min(jumpBack.length, RAIL)}>
                {jumpBack.slice(0, RAIL).map((album) => (
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

          {showHistory &&
            (skelFeed ? (
              <ShelfSkeleton title="Your top artists" kind="artist" count={RAIL} />
            ) : (
              <Shelf
                title="Your top artists"
                count={Math.min(topArtists.length, RAIL)}
                // The stats door lives where the listening is summarized:
                // these artists ARE the top of the stats page, so "view all"
                // sits beside them rather than floating over everything.
                action={
                  onOpenStats && (
                    <Button variant="ghost" size="sm" onClick={onOpenStats}>
                      <ChartNoAxesColumn size={14} />
                      <span>View all stats</span>
                    </Button>
                  )
                }
              >
                {topArtists.slice(0, RAIL).map((a) => (
                  <ArtistCard key={a.name} name={a.name} cover={a.cover} onOpen={() => onOpenArtist(a.name)} />
                ))}
              </Shelf>
            ))}

          {showHistory &&
            (skelFeed ? (
              <ShelfSkeleton title="Recently played" kind="track" count={RAIL} />
            ) : (
              <Shelf title="Recently played" count={Math.min(recent.length, RAIL)}>
                {recent.slice(0, RAIL).map((t) => (
                  <TrackCard key={t.path} track={t} onOpen={() => onPlay(t, recent)} />
                ))}
              </Shelf>
            ))}

          {/* Embedded, this stays silent: the host owns its own empty state,
              and a full-height graphic announcing emptiness inside a page that
              plainly is not empty is just wrong. */}
          {!embedded &&
            !anySkeleton &&
            curated.length === 0 &&
            mixes.length === 0 &&
            jumpBack.length === 0 &&
            topArtists.length === 0 &&
            recent.length === 0 &&
            heavy.length === 0 &&
            fresh.length === 0 &&
            (home ? true : favoriteTracks.length === 0) && (
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

interface ShelvesProps {
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  onOpenStats?: () => void;
  onTune?: (mix: { title: string; tracks: Track[] }) => void;
  daylistTaken?: boolean;
}

/** The fallback for a shelf mounted outside the Discover provider (the
 *  Booth): it fetches its own feed, exactly as every shelf once did. */
function OwnFeedShelves(props: ShelvesProps & { section: ShelfSection }) {
  const { tracks, forYou } = useLibrary();
  const { session } = useServerSession();
  const feed = useHomeFeed(tracks, session, forYou);
  return <HomeShelves {...props} feed={feed} embedded />;
}

/** One section of the shelves, on the page's shared feed when there is one
 *  and on a feed of its own otherwise. */
function SharedOrOwn(props: ShelvesProps & { section: ShelfSection }) {
  const shared = useDiscoverFeedOptional();
  if (shared) return <HomeShelves {...props} feed={shared.home} embedded />;
  return <OwnFeedShelves {...props} />;
}

/**
 * The AI's own shelves - the mixes built from your library and your listening,
 * all of them. Everything on Discover is the AI talking, so these carry no
 * badges and no explanation of which process made them. The Booth mounts
 * this whole; Discover mounts the two halves below, apart.
 */
export function CuratorShelves(props: ShelvesProps) {
  return <SharedOrOwn {...props} section="curator" />;
}

/** "Made for you" alone: the daylist and the daily and mood mixes, feature
 *  first - the top of Discover, right under the hero. */
export function MadeForYouShelf(props: ShelvesProps) {
  return <SharedOrOwn {...props} section="madeForYou" />;
}

/** "Made from your library" and "Your stations": the curator's longer tail,
 *  a long way down Discover, past the world's shelves and the people. */
export function LibraryMadeShelves(props: ShelvesProps) {
  return <SharedOrOwn {...props} section="library" />;
}

/**
 * The shelves built from what you have PLAYED - jump back in, your top
 * artists, recently played - for the Discover page, below the curator shelves.
 * Keeps the desktop's only door to the Stats page (the top-artists header).
 */
export function HistoryShelves(props: ShelvesProps) {
  return <SharedOrOwn {...props} section="history" />;
}
