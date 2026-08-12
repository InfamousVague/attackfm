import { Button, Text } from '@glacier/react';
import { Play, Repeat, Shuffle } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { SongTable } from './SongTable.tsx';
import { EmptyArt, HeroArt, type EmptyArtName } from './EmptyArt.tsx';
import { fetchHome, trackIdFromPath } from './server.ts';
import type { Track } from './tauri.ts';

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

/** The running time of the whole set, in the units it deserves. */
function formatTotal(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} hr ${mins % 60} min`;
}

/** Fisher-Yates, so "shuffle" means a jumbled ORDER of these songs - not a flip
 *  of the player's own shuffle switch, which would outlive this page. */
function shuffled(list: Track[]): Track[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a && b) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

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
  const meta = META[view];

  // All computed unconditionally (hooks must be), one chosen after. All songs
  // open newest-first to match the table's own default sort; Liked keeps the
  // favourites' own order; On repeat is the server's play ledger, most-played
  // first - the same `heavy` list the home page's Heavy rotation shelf reads,
  // shown whole instead of clipped to a shelf.
  const allNewest = useMemo(() => [...tracks].sort((a, b) => b.addedAt - a.addedAt), [tracks]);
  const [heavyIds, setHeavyIds] = useState<number[] | null>(null);
  useEffect(() => {
    if (view !== 'onrepeat' || !session) return;
    let live = true;
    void fetchHome(session)
      .then((feed) => {
        if (live) setHeavyIds(feed.heavy ?? []);
      })
      .catch(() => {
        if (live) setHeavyIds([]);
      });
    return () => {
      live = false;
    };
  }, [view, session]);
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

  const totalSeconds = listTracks.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const loading = view === 'onrepeat' && session !== null && heavyIds === null;
  const empty = listTracks.length === 0 && !loading;

  const playAll = () => {
    const first = listTracks[0];
    if (first) onPlay(first, listTracks);
  };

  const shuffleAll = () => {
    if (empty) return;
    const order = shuffled(listTracks);
    const first = order[0];
    if (first) onPlay(first, order);
  };

  return (
    <div className={`homePage libraryPage songPage ${meta.tone}`}>
      <header className="playlistHead songPageHead">
        <div className="playlistHead__cover" aria-hidden>
          <div className="tileSquircle playlistHead__mosaic songPageHero">
            {view === 'onrepeat' ? (
              <span className="songPageHero__repeat" aria-hidden>
                <Repeat size={64} strokeWidth={2.25} />
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
            {listTracks.length} {listTracks.length === 1 ? 'song' : 'songs'}
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

      {loading ? null : empty ? (
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
            <SongTable tracks={listTracks} onPlay={onPlay} onOpenArtist={onOpenArtist} />
          </div>
        </section>
      )}
    </div>
  );
}
