import { Check, ListMusic, Plus } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useRippleWave } from '../ux/rippleWave.ts';
import { Shelf } from '../home/homeCards.tsx';
import { ShelfSkeleton } from '../ux/ShelfSkeleton.tsx';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { HistoryShelves, LibraryMadeShelves, MadeForYouShelf } from '../library/HomePage.tsx';
import { NewMusicShelf } from '../library/NewMusicShelf.tsx';
import { PlaylistShowcase } from '../playlists/PlaylistShowcase.tsx';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import { fetchDiscover, type Suggestion } from '../server.ts';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../../plugins/runtime.tsx';
import { useDownloadsOptional, type MusicImportJob } from '../../plugins/importsBridge.ts';
import type { AcquireTarget } from '../../plugins/types.ts';
import type { Track } from '../core/tauri.ts';
import type { SongCollection } from '../library/SongPage.tsx';
import { DiscoverFeedProvider, useDiscoverFeed } from '../home/DiscoverFeed.tsx';
import { DiscoverHero, heroLead } from './DiscoverHero.tsx';
import { TrendingShelves } from './TrendingShelves.tsx';
import { PeopleShelf } from './PeopleShelf.tsx';

/**
 * Discover: everything the machine has to say.
 *
 * The Library is what you saved or made - liked songs, your playlists, the
 * music you added. This page is the other half of the app: what the server
 * built from your listening, what the collector fetched and is waiting on a
 * listen, what is moving on the charts near your taste, who else is here,
 * and the shelves derived from your history. Nothing here was chosen by you;
 * that is the point of the split.
 *
 * Editorial and art-first, by request. It opens on one big thing wearing its
 * music (the hero), and every rail below it is short and its first card
 * large. The order down the page is how close each row is to you: made for
 * you, then the world through your taste (three trending shelves, never
 * blended), then what is new, then people, then the longer tail.
 *
 * One feed. `DiscoverFeedProvider` fetches everything the shelves read
 * exactly once; the shelves are readers. The catalogue suggestions at the
 * foot are the one exception, and they wait until they are nearly in view.
 */
export function DiscoverPage({
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  onOpenList,
  onOpenSongs,
  onOpenStats,
  onOpenFriends,
}: {
  onPlay: (track: Track, context?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  onOpenPlaylist: (id: string) => void;
  /** Open a catalogue list as a page, to read before taking it. */
  onOpenList: (suggestion: Suggestion) => void;
  onOpenSongs: (view: SongCollection) => void;
  onOpenStats?: () => void;
  /** The Friends page - the People shelf's live card leads there. */
  onOpenFriends?: () => void;
}) {
  const { session } = useServerSession();
  // The entrance wave: cards ripple in as they meet the view, each landing
  // with a soft tick - see rippleWave.ts. Watching the page root covers every
  // shelf below at once; the embedded shelves defer to the first registration.
  const [rippleRoot, setRippleRoot] = useState<HTMLDivElement | null>(null);
  useRippleWave(rippleRoot);

  return (
    <div className="homePage discoverTab" ref={setRippleRoot}>
      {!session ? (
        <div className="emptyState emptyState--tall">
          <EmptyArt name="discovery" />
          <p className="emptyState__text">
            Sign in to a server and this page fills with what it finds for you.
          </p>
        </div>
      ) : (
        <DiscoverFeedProvider>
          <DiscoverBody
            onPlay={onPlay}
            onOpenArtist={onOpenArtist}
            onOpenAlbum={onOpenAlbum}
            onOpenPlaylist={onOpenPlaylist}
            onOpenList={onOpenList}
            onOpenSongs={onOpenSongs}
            onOpenStats={onOpenStats}
            onOpenFriends={onOpenFriends}
          />
        </DiscoverFeedProvider>
      )}
    </div>
  );
}

function DiscoverBody({
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  onOpenList,
  onOpenSongs,
  onOpenStats,
  onOpenFriends,
}: {
  onPlay: (track: Track, context?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  onOpenPlaylist: (id: string) => void;
  onOpenList: (suggestion: Suggestion) => void;
  onOpenSongs: (view: SongCollection) => void;
  onOpenStats?: () => void;
  onOpenFriends?: () => void;
}) {
  const feed = useDiscoverFeed();
  const { tracks } = useLibrary();
  const lead = useMemo(() => heroLead(feed, tracks), [feed, tracks]);

  return (
    <>
      {/* The hero: one thing, big, wearing its music - and the page's two
          doors (All songs, Music Date) in its action row. */}
      <DiscoverHero lead={lead} onPlay={onPlay} onOpenSongs={onOpenSongs} />

      {/* What the curator MADE for you, the near half: the daylist (unless
          the hero took it) and the daily and mood mixes, feature first. The
          longer tail - made from your library, the stations - sits below the
          people, where it is one of the longer rows rather than the opening. */}
      <MadeForYouShelf onPlay={onPlay} onOpenArtist={onOpenArtist} daylistTaken={lead.kind === 'daylist'} />

      {/* The world, through your taste: three shelves, each labelled by the
          server for the claim it makes, never folded into one. */}
      <TrendingShelves onPlay={onPlay} />

      {/* What is new to you: the pool's lists, feature first, and the songs
          the collector already fetched, waiting on a listen. */}
      <NewMusicShelf onPlay={onPlay} />

      {/* The other people: friends listening now, a jam to join, Music Date. */}
      <PeopleShelf onOpenFriends={onOpenFriends} />

      {/* The curator's longer tail: everything else it built from the
          library, and the stations. */}
      <LibraryMadeShelves onPlay={onPlay} onOpenArtist={onOpenArtist} />

      {/* The charts the server keeps as playlists of songs already on the
          box - generated, refreshed on their own clock, never yours to file.
          Only the charts: the "New music" folder said "new" a third time. */}
      <PlaylistShowcase
        show="generated"
        onPlay={onPlay}
        onOpenPlaylist={onOpenPlaylist}
        onOpenArtist={onOpenArtist}
        onOpenSongs={onOpenSongs}
      />

      {/* The shelves derived from what you have PLAYED: jump back in, your
          top artists, recently played. Yours in the sense that it is your
          history, the machine's in that it did the reading. */}
      <HistoryShelves
        onPlay={onPlay}
        onOpenArtist={onOpenArtist}
        onOpenAlbum={onOpenAlbum}
        onOpenStats={onOpenStats}
      />

      {/* Lists the catalogues are pushing right now, one tap from the
          importer. Four sections chosen by how much they overlap your taste,
          a few cards each. Last on the page, and fetched only when the page
          has been scrolled nearly to them. */}
      <SuggestedLists onOpen={onOpenList} />
    </>
  );
}

/** A suggestion as the importer wants it named. Every suggestion is a link
 *  to a list; `kind` says which shape when the server knows. */
export function suggestionTarget(item: Suggestion): AcquireTarget {
  const kind: AcquireTarget['kind'] =
    item.kind === 'album' ? 'album' : item.kind === 'track' ? 'track' : 'playlist';
  return { kind, title: item.title, url: item.url };
}

/** How many catalogue sections the page shows at once, and how deep each
 *  goes. The feed offers up to twenty-eight sections and hundreds of cards;
 *  a page is a place to glance, not a catalogue to scroll to the floor of. */
const SHOWN_SECTIONS = 4;
const PER_SECTION = 6;

/** The global chart is its own trending shelf now, labelled by the server;
 *  offered again here, unfiltered, it would be the one blend the page
 *  promised never to make. */
const BLENDED_SECTION = 'Trending now';

/** Where a card is, from the download queue rather than a click a moment ago:
 *  a copy this device asked for on any surface reads the same, and it survives
 *  a remount. */
type AddState = 'idle' | 'adding' | 'added';
function addStateOf(job: MusicImportJob | undefined): AddState {
  if (!job) return 'idle';
  if (job.state === 'done') return 'added';
  if (job.state === 'queued' || job.state === 'downloading') return 'adding';
  return 'idle';
}

/** The words a library's genre tags are made of, most common first. */
function topGenres(tracks: readonly Track[], take = 6): string[] {
  const counts = new Map<string, number>();
  for (const t of tracks) {
    if (!t.genre) continue;
    for (const raw of t.genre.split(/[,/;&]+/)) {
      const word = raw.trim().toLowerCase();
      if (word.length < 3) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, take)
    .map(([w]) => w);
}

/**
 * The catalogues' own suggestions - chart playlists and editorial sets, from
 * Spotify and Deezer - grouped the way the server groups them.
 *
 * Only the cards THIS box can actually fetch are shown (a Buy-only device
 * cannot take a Spotify playlist link, so those cards are dropped rather than
 * offered as a tap that does nothing). The feed is server-wide and arrives in
 * the server's order, so the four sections shown are chosen HERE, by how much
 * each overlaps this listener - the artists on the cards against the month's
 * top artists, the section's words against the library's own genre tags -
 * rather than by which four the server happened to build first.
 *
 * Fetched late: this is the last shelf on a long page, and it asks for its
 * feed only once the page has been scrolled to within a screen of it. Until
 * then it holds its seat as a skeleton, which is also what the observer
 * watches.
 */
function SuggestedLists({ onOpen }: { onOpen: (item: Suggestion) => void }) {
  const { session } = useServerSession();
  const { home } = useDiscoverFeed();
  const { tracks } = useLibrary();
  const acquire = useAcquire();
  const downloads = useDownloadsOptional();
  const refreshNonce = useRefreshNonce();
  const [items, setItems] = useState<Suggestion[] | null>(null);
  const [near, setNear] = useState(false);
  const [seat, setSeat] = useState<HTMLElement | null>(null);

  // Can anything on this box take a list at all? Decided before the fetch, so
  // a device with no way to fetch never flashes the skeleton.
  const canFetchLists = acquire.hasAny;

  // Near the viewport, or an engine with no observer (then at once).
  useEffect(() => {
    if (near || !seat) return;
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: '100% 0px' },
    );
    io.observe(seat);
    return () => io.disconnect();
  }, [near, seat]);

  useEffect(() => {
    if (!session || !canFetchLists || !near) {
      setItems(null);
      return;
    }
    let live = true;
    fetchDiscover(session)
      .then((list) => {
        if (live) setItems(list);
      })
      // Kept quiet, like every other feed on this page: a shelf that cannot
      // load is a shelf that is not there, not a page with an error on it.
      .catch(() => {
        if (live) setItems([]);
      });
    return () => {
      live = false;
    };
  }, [session, canFetchLists, near, refreshNonce]);

  const topArtists = home.feed?.topArtists ?? [];
  const genres = useMemo(() => topGenres(tracks), [tracks]);

  // Group, keeping only the cards a handler on this box can take; drop the
  // blended chart; score each section against the listener; keep the four
  // that overlap most, capped in depth. `acquire` identity changes on a
  // handler-set change, so a plugin toggle re-gates this.
  const sections = useMemo(() => {
    const all: { section: string; items: Suggestion[] }[] = [];
    for (const item of items ?? []) {
      if (item.section === BLENDED_SECTION) continue;
      if (!acquire.hasHandlers(suggestionTarget(item))) continue;
      let bucket = all.find((s) => s.section === item.section);
      if (!bucket) {
        bucket = { section: item.section, items: [] };
        all.push(bucket);
      }
      bucket.items.push(item);
    }
    const artists = new Set(topArtists.map((a) => a.toLowerCase()));
    const score = (s: { section: string; items: Suggestion[] }) => {
      let n = 0;
      const words = `${s.section} ${s.items.map((i) => `${i.title} ${i.blurb}`).join(' ')}`.toLowerCase();
      for (const g of genres) if (words.includes(g)) n += 1;
      for (const i of s.items) {
        const names = (i.items ?? []).map((t) => t.artist?.toLowerCase() ?? '');
        if (names.some((a) => a && artists.has(a))) n += 2;
      }
      return n;
    };
    return all
      .map((s, order) => ({ s, order, score: score(s) }))
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, SHOWN_SECTIONS)
      .map(({ s }) => ({ section: s.section, items: s.items.slice(0, PER_SECTION) }));
  }, [items, acquire, topArtists, genres]);

  if (!session || !canFetchLists) return null;
  if (items === null) {
    return (
      <div ref={setSeat}>
        <ShelfSkeleton title="Suggested playlists" kind="mix" count={3} />
      </div>
    );
  }
  if (sections.length === 0) return null;

  const add = (item: Suggestion, viaImporter: boolean) => {
    const target = suggestionTarget(item);
    // Straight down the importer's own queue when it is running; the chooser
    // otherwise - the same path the artist page's Add takes. Only the importer
    // path is tracked (the queue tracks it); the store is its own feedback.
    if (viaImporter && downloads) void downloads.enqueue(item.url).catch(() => {});
    else acquire.acquire(target);
  };

  return (
    <>
      {sections.map((s) => (
        <Shelf key={s.section} title={s.section} count={s.items.length}>
          {s.items.map((item) => {
            const viaImporter = acquire
              .handlersFor(suggestionTarget(item))
              .some((h) => h.pluginId === IMPORTER_PLUGIN_ID);
            const state = viaImporter
              ? addStateOf(downloads?.jobs.find((j) => j.url === item.url))
              : 'idle';
            const label =
              state === 'added'
                ? `${item.title} is in your library`
                : state === 'adding'
                  ? `${item.title} is downloading`
                  : `Add ${item.title}`;
            return (
              <div className="suggestCard" key={item.id}>
                {/* The card OPENS the list. Add is its own control, below,
                    a sibling of the card's button, never nested inside it. */}
                <button
                  type="button"
                  className="suggestCardBody"
                  aria-label={`${item.title} - see what is on it`}
                  onClick={() => onOpen(item)}
                >
                  <div className="suggestCardCover">
                    {item.cover ? (
                      <img src={item.cover} alt="" loading="lazy" />
                    ) : (
                      <div className="suggestCardCover--glyph" aria-hidden>
                        <ListMusic size={22} />
                      </div>
                    )}
                    {item.source && (
                      <span className={`suggestCardSource suggestCardSource--${item.source}`}>
                        {item.source === 'spotify' ? 'Spotify' : item.source === 'deezer' ? 'Deezer' : item.source}
                      </span>
                    )}
                    {viaImporter && state !== 'idle' && (
                      <span className="suggestCardAdd" aria-hidden>
                        <Check size={14} />
                      </span>
                    )}
                  </div>
                  <span className="suggestCardTitle">{item.title}</span>
                  <span className="suggestCardBlurb">
                    {item.trackCount ? `${item.trackCount} songs` : item.blurb}
                  </span>
                </button>
                <button
                  type="button"
                  className="suggestCardTake"
                  aria-label={label}
                  disabled={state !== 'idle'}
                  onClick={() => add(item, viaImporter)}
                >
                  {state === 'idle' ? <Plus size={14} /> : <Check size={14} />}
                  <span>{state === 'added' ? 'Added' : state === 'adding' ? 'Adding…' : 'Add'}</span>
                </button>
              </div>
            );
          })}
        </Shelf>
      ))}
    </>
  );
}
