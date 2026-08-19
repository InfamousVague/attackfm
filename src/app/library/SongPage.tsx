import { Button, SearchField, Text } from '@glacier/react';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import { Play, Shuffle } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from './library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { SongTable } from './SongTable.tsx';
import { setHeaderActions } from '../nav/headerActions.ts';
import { EmptyArt, HeroArt, type EmptyArtName } from '../ux/EmptyArt.tsx';
import { fetchHome, trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';
import { formatTotal } from '../ux/format.ts';
import { shuffled } from '../ux/shuffle.ts';
import onRepeatChip from '../../assets/chip-on-repeat.png';
import likedChip from '../../assets/chip-liked.png';

/**
 * A whole collection of songs, opened as its own page - the fullscreen answer
 * to the old header "All" toggle, now reused for Liked too. It stacks inside
 * whichever tab opened it (like an artist or playlist page), so Back returns to
 * where you came from.
 *
 * The body is the SAME song table the library's "All" face draws, so a
 * collection reads identically wherever it is opened; the header is what
 * differs - a hero drawn from the app's own art (the neon Liked heart, the
 * library motif) and Play / Shuffle over the whole set. Neither collection is a
 * hand-ordered list, so there is nothing here to reorder, rename or delete: it
 * is a WINDOW on the library, filtered.
 */

export type SongCollection = 'liked' | 'all' | 'onrepeat';

const META: Record<
  SongCollection,
  { kicker: string; title: string; art: EmptyArtName; tone: string; empty: string }
> = {
  liked: {
    kicker: 'Your library',
    title: 'Liked songs',
    art: 'liked',
    tone: 'songPage--liked',
    empty: 'No liked songs yet. Tap the heart while a song plays and it lands here.',
  },
  all: {
    kicker: 'Your library',
    title: 'All songs',
    art: 'library',
    tone: 'songPage--all',
    empty: 'No music in your library yet. Sign in to your server or import songs to fill it.',
  },
  onrepeat: {
    kicker: 'Your library',
    title: 'On repeat',
    art: 'library',
    tone: 'songPage--repeat',
    empty:
      'Nothing on repeat yet. Play your library for a while and the songs you keep returning to gather here.',
  },
};

export function SongPage({
  view,
  onPlay,
  onOpenArtist,
}: {
  view: SongCollection;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
}) {
  const { tracks, favoriteTracks } = useLibrary();
  const { session } = useServerSession();
  // Pull-to-refresh re-runs the fetch below - see nav/pageRefresh.tsx.
  const refreshNonce = useRefreshNonce();
  const meta = META[view];

  // All computed unconditionally (hooks must be), one chosen after. All songs
  // open newest-first to match the table's own default sort; Liked keeps the
  // favourites' own order; On repeat is the server's play ledger, most-played
  // first - the same `heavy` list the home page's Heavy rotation shelf reads,
  // shown whole instead of clipped to a shelf.
  const allNewest = useMemo(() => [...tracks].sort((a, b) => b.addedAt - a.addedAt), [tracks]);
  const [heavyIds, setHeavyIds] = useState<number[] | null>(null);
  // How many times each of them was played - what the On repeat page shows in
  // place of a row number, since that count IS the page's subject.
  const [playsById, setPlaysById] = useState<Map<number, number>>(new Map());
  useEffect(() => {
    if (view !== 'onrepeat' || !session) return;
    let live = true;
    void fetchHome(session)
      .then((feed) => {
        if (!live) return;
        setHeavyIds(feed.heavy ?? []);
        setPlaysById(new Map((feed.heavyPlays ?? []).map((h) => [h.id, h.plays])));
      })
      .catch(() => {
        if (live) setHeavyIds([]);
      });
    return () => {
      live = false;
    };
  }, [view, session, refreshNonce]);
  const onRepeat = useMemo(() => {
    if (!heavyIds) return [];
    const byId = new Map<number, Track>();
    for (const t of tracks) {
      const id = trackIdFromPath(t.path);
      if (id !== null) byId.set(id, t);
    }
    return heavyIds.map((id) => byId.get(id)).filter((t): t is Track => t !== undefined);
  }, [heavyIds, tracks]);
  const listTracks = view === 'liked' ? favoriteTracks : view === 'onrepeat' ? onRepeat : allNewest;

  /*
   * Filtering the table, as opposed to searching the library.
   *
   * These are different jobs and deserve different tools. Search is a place
   * you go to find a song among everything there is; this narrows the rows in
   * front of you and never leaves the page - the table equivalent of squinting
   * at a list you are already looking at. So it is a plain substring match
   * over title, artist and album: predictable beats clever when the answer is
   * meant to be visibly a subset of what was already on screen. No operators,
   * no typo rescue, no network.
   */
  const [filter, setFilter] = useState('');
  const filtering = filter.trim().length > 0;
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return listTracks;
    // Every word has to land somewhere, so "fike babydoll" finds the song
    // without the words having to be typed in the order the tags happen to
    // hold them.
    const words = q.split(/\s+/);
    return listTracks.filter((t) => {
      const hay = `${t.title} ${t.artist} ${t.album ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [filter, listTracks]);

  const totalSeconds = shown.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const loading = view === 'onrepeat' && session !== null && heavyIds === null;
  const empty = listTracks.length === 0 && !loading;

  /**
   * Whether the hero has scrolled out of the way.
   *
   * Watched with an observer on a sentinel rather than a scroll handler: the
   * question is only ever "is the header still on screen", and answering it
   * from scroll offsets means a listener firing on every frame of a flick to
   * recompute something the browser already knows.
   */
  const pageRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const root = pageRef.current;
    const mark = sentinelRef.current;
    if (!root || !mark) return;
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!entry?.isIntersecting),
      { root, threshold: 0 },
    );
    observer.observe(mark);
    return () => observer.disconnect();
    // Re-armed per view: switching collections replaces the header the
    // sentinel sits under.
  }, [view]);

  // Play and Shuffle take the rows on screen: with a filter typed, "play this"
  // can only sensibly mean the list you filtered to, not the four thousand
  // songs behind it.
  const playAll = () => {
    const first = shown[0];
    if (first) onPlay(first, shown);
  };

  const shuffleAll = () => {
    if (shown.length === 0) return;
    const order = shuffled(shown);
    const first = order[0];
    if (first) onPlay(first, order);
  };

  /*
   * Lend Play and Shuffle to the app header while the hero is off screen.
   *
   * The handlers go through a ref so this publishes on `stuck` and `empty`
   * alone: they close over the current track list, so as effect dependencies
   * they would be a fresh pair every render and re-publish forever. Withdrawn
   * on cleanup, so leaving the page - or scrolling back up to where the hero's
   * own buttons are on screen - takes them with it rather than leaving a live
   * Play up there pointing at a list nobody is looking at.
   */
  const handlers = useRef({ playAll, shuffleAll });
  handlers.current = { playAll, shuffleAll };
  useEffect(() => {
    if (!stuck) return;
    setHeaderActions({
      title: meta.title,
      // Liked and On repeat wear a real object; the library motif is painted
      // onto the page background (see EmptyArt) and reads as a smudge at
      // thumbnail size, so it sends none and the header shows the name alone.
      art: view === 'liked' ? likedChip : view === 'onrepeat' ? onRepeatChip : null,
      play: () => handlers.current.playAll(),
      shuffle: () => handlers.current.shuffleAll(),
      disabled: empty,
    });
    return () => setHeaderActions(null);
  }, [stuck, empty, meta.title, view]);

  return (
    <div className={`homePage libraryPage songPage ${meta.tone}`} ref={pageRef}>
      {/* No collapsed strip here any more. It used to restate the mark and the
          name under a header that was already a row of chrome; now the name
          rides the header itself (see the effect above, and .mobileHeader__ident)
          and the page gets those three rems back for songs. */}
      <header className="playlistHead songPageHead">
        <div className="playlistHead__cover" aria-hidden>
          <div className="tileSquircle playlistHead__mosaic songPageHero">
            {view === 'onrepeat' ? (
              <span className="songPageHero__repeat" aria-hidden>
                <img src={onRepeatChip} alt="" />
              </span>
            ) : view === 'liked' ? (
              /* The same glossy heart the chip wears, on the chip's own
                 crimson - one heart for Liked everywhere, by request. */
              <span className="songPageHero__repeat songPageHero--liked" aria-hidden>
                <img src={likedChip} alt="" />
              </span>
            ) : (
              <HeroArt name={meta.art} />
            )}
          </div>
        </div>

        <div className="playlistHead__body">
          <Text tone="muted" size="xs" className="playlistHead__kicker">
            {meta.kicker}
          </Text>
          <h2 className="playlistHead__name">{meta.title}</h2>
          <Text tone="muted" size="sm">
            {shown.length} {shown.length === 1 ? 'song' : 'songs'}
            {filtering ? ` of ${listTracks.length}` : ''}
            {totalSeconds > 0 ? ` · ${formatTotal(totalSeconds)}` : ''}
          </Text>

          <div className="playlistHead__actions">
            <Button variant="solid" size="sm" onClick={playAll} disabled={empty}>
              <Play size={15} fill="currentColor" />
              Play
            </Button>
            <Button variant="ghost" size="sm" onClick={shuffleAll} disabled={empty}>
              <Shuffle size={15} />
              Shuffle
            </Button>
          </div>
        </div>
      </header>
      {/* Sits just under the hero: once this leaves the top of the page, the
          hero has gone with it. */}
      <div ref={sentinelRef} className="songPageHead__sentinel" aria-hidden />

      {/* The filter sits between the hero and the table it narrows, which is
          the only place it can sit and still read as belonging to the rows
          rather than to the page. Only on All songs: it is the list long
          enough to need one. */}
      {view === 'all' && !empty && (
        <div className="songFilter">
          <SearchField
            className="pageSearch"
            value={filter}
            onValueChange={setFilter}
            placeholder="Filter these songs"
            aria-label="Filter these songs"
            autoComplete="off"
          />
        </div>
      )}

      {empty && !loading ? (
        <div className="playlistEmpty emptyState emptyState--tall">
          <EmptyArt name={meta.art} />
          <Text tone="muted">{meta.empty}</Text>
        </div>
      ) : (
        // The same table the "All" library face draws, so a collection reads
        // identically wherever it is opened. It carries its own bounded height
        // and scroll; the header sits above it.
        <section className="homeShelf librarySongs">
          <div className="libraryBody">
            {filtering && shown.length === 0 ? (
              <Text tone="muted" className="songFilter__none">
                No song here matches “{filter.trim()}”.
              </Text>
            ) : (
            <SongTable
              flow
              loading={loading}
              tracks={shown}
              onPlay={onPlay}
              onOpenArtist={onOpenArtist}
              plays={view === 'onrepeat' && playsById.size > 0 ? playsById : undefined}
            />
            )}
          </div>
        </section>
      )}
    </div>
  );
}
