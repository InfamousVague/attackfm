import { Check, ListMusic, Plus } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useRippleWave } from '../ux/rippleWave.ts';
import { Shelf } from '../home/homeCards.tsx';
import { ShelfSkeleton } from '../ux/ShelfSkeleton.tsx';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { CuratorShelves, HistoryShelves } from '../library/HomePage.tsx';
import { ForYouShelf } from '../library/ForYouShelf.tsx';
import { NewMusicShelf } from '../library/NewMusicShelf.tsx';
import { MusicDateChip } from '../library/MusicDateChip.tsx';
import { AllSongsChip } from '../library/AllSongsChip.tsx';
import { PlaylistShowcase } from '../playlists/PlaylistShowcase.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import { fetchDiscover, type Suggestion } from '../server.ts';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../../plugins/runtime.tsx';
import { useDownloadsOptional, type MusicImportJob } from '../../plugins/importsBridge.ts';
import type { AcquireTarget } from '../../plugins/types.ts';
import type { Track } from '../core/tauri.ts';
import type { SongCollection } from '../library/SongPage.tsx';

/**
 * Discover: everything the machine has to say.
 *
 * The Library is what you saved or made - liked songs, your playlists, the
 * music you added. This page is the other half of the app, the half that
 * used to be folded into the Library's scroller and made it four pages long:
 * what the server built from your listening (the daylist, the daily and mood
 * mixes, the stations), what the collector fetched for you and is waiting on
 * a listen, what it has only found so far, the charts it keeps as playlists,
 * the lists it suggests from the catalogues, and the shelves it derives from
 * your history. Nothing here was chosen by you; that is the point of the
 * split, and why the two pages are two tabs.
 *
 * Built from the same shelf components the Library used to render, each of
 * which owns its own feed, cache and skeletons - this page is the frame, not
 * a second loader.
 */
export function DiscoverPage({
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  onOpenList,
  onOpenSongs,
  onOpenStats,
}: {
  onPlay: (track: Track, context?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  onOpenPlaylist: (id: string) => void;
  /** Open a catalogue list as a page, to read before taking it. */
  onOpenList: (suggestion: Suggestion) => void;
  onOpenSongs: (view: SongCollection) => void;
  onOpenStats?: () => void;
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
        <>
          {/* Two doors, by request: everything - the pile you browse when you
              are looking for something - and the deck of what the collector
              went and got. Chips, like the Library's own row, so the page
              opens on something to tap rather than a shelf that may still be
              loading. */}
          <section className="homeShelf libShelf">
            <div className="libChips">
              <AllSongsChip onOpenSongs={onOpenSongs} />
              <MusicDateChip />
            </div>
          </section>

          {/* What the curator MADE from this library: the daylist, the daily
              and mood mixes, made-from-your-library, the stations. Every
              track is already owned, so these play the instant they are
              tapped. */}
          <CuratorShelves onPlay={onPlay} onOpenArtist={onOpenArtist} />

          {/* What the collector went and FETCHED, waiting on a listen to earn
              its place - and, one step further out, what it has only FOUND.
              The order down this page is how certain each row is. */}
          <ForYouShelf onPlay={onPlay} />
          <NewMusicShelf />

          {/* The charts and the new-music list the server keeps as playlists
              of its own - generated, refreshed on their own clock, never
              yours to file. They were indistinguishable from your folders
              on the Library; here they are what they are. */}
          <PlaylistShowcase
            show="generated"
            onPlay={onPlay}
            onOpenPlaylist={onOpenPlaylist}
            onOpenArtist={onOpenArtist}
            onOpenSongs={onOpenSongs}
          />

          {/* The shelves derived from what you have PLAYED: jump back in,
              your top artists, recently played. Yours in the sense that it is
              your history, the machine's in that it did the reading. Above the
              catalogue suggestions because these are about YOU. */}
          <HistoryShelves
            onPlay={onPlay}
            onOpenArtist={onOpenArtist}
            onOpenAlbum={onOpenAlbum}
            onOpenStats={onOpenStats}
          />

          {/* Lists the catalogues are pushing right now, one tap from the
              importer. Only the cards this box can actually fetch, and only a
              few sections deep - the feed offers dozens, which would bury
              everything above it. Last on the page for the same reason. */}
          <SuggestedLists onOpen={onOpenList} />
        </>
      )}
    </div>
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
const PER_SECTION = 12;

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

/**
 * The catalogues' own suggestions - chart playlists and editorial sets, from
 * Spotify and Deezer - grouped the way the server groups them. The old
 * Discover page's feed (`GET /api/discover`), which sat unread from the day
 * that page was deleted.
 *
 * Only the cards THIS box can actually fetch are shown (a Buy-only device
 * cannot take a Spotify playlist link, so those cards are dropped rather than
 * offered as a tap that does nothing), and only a few sections deep. A card
 * routed through the importer says where it is - adding, then in your library -
 * read from the download queue; a card the store handles opens the store and
 * makes no such promise.
 */
function SuggestedLists({ onOpen }: { onOpen: (item: Suggestion) => void }) {
  const { session } = useServerSession();
  const acquire = useAcquire();
  const downloads = useDownloadsOptional();
  const refreshNonce = useRefreshNonce();
  const [items, setItems] = useState<Suggestion[] | null>(null);

  // Can anything on this box take a list at all? Decided before the fetch, so
  // a device with no way to fetch never flashes the skeleton.
  const canFetchLists = acquire.hasAny;

  useEffect(() => {
    if (!session || !canFetchLists) {
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
  }, [session, canFetchLists, refreshNonce]);

  // Group, keeping only the cards a handler on this box can take, and cap the
  // depth. `acquire` identity changes on a handler-set change, so a plugin
  // toggle re-gates this.
  const sections = useMemo(() => {
    const out: { section: string; items: Suggestion[] }[] = [];
    for (const item of items ?? []) {
      if (!acquire.hasHandlers(suggestionTarget(item))) continue;
      let bucket = out.find((s) => s.section === item.section);
      if (!bucket) {
        if (out.length >= SHOWN_SECTIONS) continue;
        bucket = { section: item.section, items: [] };
        out.push(bucket);
      }
      if (bucket.items.length < PER_SECTION) bucket.items.push(item);
    }
    return out;
  }, [items, acquire]);

  if (!session || !canFetchLists) return null;
  if (items === null) return <ShelfSkeleton title="Suggested playlists" kind="mix" count={3} />;
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
                {/* The card OPENS the list. Tapping it used to be the import
                    itself - fifty songs on a title and a picture, with no way
                    to see what was on it first - and the songs were on the
                    wire the whole time. Add is its own control now, below,
                    and does exactly what the tap used to. */}
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
                {/* A sibling of the card's button, never nested inside it -
                    two verbs, and the smaller one must not ride the tap that
                    opens the list. */}
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
