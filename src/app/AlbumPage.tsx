import { Button, Text } from '@glacier/react';
import { Disc3, Play, Shuffle } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from './library.tsx';
import { useArtLoad } from './artLoad.ts';
import { artSized } from './server.ts';
import { TrackMenu } from './TrackMenu.tsx';
import { setHeaderActions } from './headerActions.ts';
import { albumCredit, byRunningOrder, fold, isBy } from './albums.ts';
import type { Track } from './tauri.ts';

/**
 * One record, opened.
 *
 * Until now a tap on an album PLAYED it, which is the one thing a listener can
 * already do from the shelf and not the thing they were reaching for: an album
 * cover is a door. There was nowhere to go - no album page existed - so this
 * is that page, and it deliberately answers the questions the artist page
 * cannot: what is actually on this record, in the order it was meant to run,
 * which of it is yours, and how long it is.
 *
 * The tracks are gathered by the same rules the artist page uses (albums.ts),
 * so the two can never disagree about what is on a record - the disagreement
 * being exactly what made the counts on the artist page wrong.
 */

interface AlbumPageProps {
  album: string;
  /** Who the shelf credited it to, which is how it was reached. Kept so two
   *  different records with one title do not collapse into each other. */
  artist: string;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** The album no longer exists in the library - every track of it removed. */
  onGone: () => void;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

function formatTotal(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  return `${hours} hr ${mins % 60} min`;
}

/** The cover, with the skeleton-then-pop every other art on the page wears. */
function Cover({ art }: { art: string | null }) {
  const src = artSized(art, 640) ?? null;
  const load = useArtLoad(src, '');
  if (!src) {
    return (
      <div className="albumHead__cover albumHead__cover--glyph" aria-hidden>
        <Disc3 size={40} />
      </div>
    );
  }
  return <img {...load} className="albumHead__cover" src={src} alt="" />;
}

export function AlbumPage({ album, artist, onPlay, onOpenArtist, onGone }: AlbumPageProps) {
  const { tracks } = useLibrary();

  // Every track on this record: the album name matches, and the artist is one
  // of its credits - the second half being what keeps two different records
  // called "Greatest Hits" apart.
  const list = useMemo(() => {
    const want = fold(album);
    return tracks.filter((t) => fold(t.album || 'Unknown album') === want && isBy(t, artist))
      .slice()
      .sort(byRunningOrder);
  }, [tracks, album, artist]);

  /*
   * Every hook sits above the empty check below, because hooks must: a render
   * that bails early would call fewer of them than the one before it, which
   * React treats as a broken component and tears the whole app down. This page
   * exists because that rule was broken once already on PlaylistPage.
   */
  const pageRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const root = pageRef.current;
    const mark = sentinelRef.current;
    if (!root || !mark) return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry?.isIntersecting), {
      root,
      threshold: 0,
    });
    observer.observe(mark);
    return () => observer.disconnect();
  }, [album, artist]);

  const cover = list.find((t) => t.artwork)?.artwork ?? null;
  const handlers = useRef<{ playAll: () => void; shuffleAll: () => void }>({
    playAll: () => {},
    shuffleAll: () => {},
  });
  useEffect(() => {
    if (!stuck || list.length === 0) return;
    setHeaderActions({
      title: album,
      art: cover,
      play: () => handlers.current.playAll(),
      shuffle: () => handlers.current.shuffleAll(),
      disabled: false,
    });
    return () => setHeaderActions(null);
  }, [stuck, album, cover, list.length]);

  /*
   * A record whose last track was deleted is not a page; step back rather than
   * stand on an empty one.
   *
   * The hard part is that "no tracks yet" and "no such album" look identical
   * from here, and only one is a reason to leave. The library's own `loading`
   * cannot tell them apart - it is hardcoded false for a server library, where
   * the tracks arrive over the network well after this mounts - so a naive
   * check bounces straight back out of a page opened on a cold start.
   *
   * Two things say the album is really gone: having HELD it and lost it, or a
   * library that has songs in it and none of them this record's.
   */
  const everHad = useRef(false);
  useEffect(() => {
    if (list.length > 0) {
      everHad.current = true;
      return;
    }
    if (everHad.current || tracks.length > 0) onGone();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the transition, not on onGone changing
  }, [list.length, tracks.length]);

  // Still arriving: hold the page rather than flash an empty one on the way.
  if (list.length === 0) return null;

  const credit = albumCredit(list);
  const totalSeconds = list.reduce((sum, t) => sum + (t.duration ?? 0), 0);
  const year = list.find((t) => t.year)?.year ?? null;
  // Discs only announce themselves on a set that has more than one; a single
  // disc wearing a "Disc 1" heading is a label for a distinction that is not
  // being made.
  const discs = [...new Set(list.map((t) => t.discNo ?? 1))].sort((a, b) => a - b);
  const multiDisc = discs.length > 1;

  const playAll = () => onPlay(list[0]!, list);
  const shuffleAll = () => {
    const shuffled = [...list];
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    onPlay(shuffled[0]!, shuffled);
  };
  handlers.current = { playAll, shuffleAll };

  return (
    <div className="homePage libraryPage albumPage" ref={pageRef}>
      <header className="albumHead">
        <Cover art={cover} />
        <div className="albumHead__body">
          <Text tone="muted" size="xs" className="albumHead__kicker">
            Album
          </Text>
          <h2 className="albumHead__name">{album}</h2>
          {/* The credit is a door back to the artist, the same as every other
              artist name in the app. "Various artists" is not one - there is no
              single page behind it. */}
          {credit === 'Various artists' ? (
            <Text tone="muted" size="sm">
              Various artists
            </Text>
          ) : (
            <button
              type="button"
              className="albumHead__artist"
              onClick={() => onOpenArtist(credit)}
            >
              {credit}
            </button>
          )}
          <Text tone="muted" size="sm">
            {list.length} {list.length === 1 ? 'song' : 'songs'}
            {totalSeconds > 0 ? ` · ${formatTotal(totalSeconds)}` : ''}
            {multiDisc ? ` · ${discs.length} discs` : ''}
            {year ? ` · ${year}` : ''}
          </Text>
          <div className="albumHead__actions">
            <Button variant="solid" size="sm" onClick={playAll}>
              <Play size={15} fill="currentColor" />
              Play
            </Button>
            <Button variant="ghost" size="sm" onClick={shuffleAll}>
              <Shuffle size={15} />
              Shuffle
            </Button>
          </div>
        </div>
      </header>
      <div ref={sentinelRef} aria-hidden />

      {discs.map((disc) => (
        <section key={disc} className="albumDisc">
          {multiDisc && (
            <Text tone="subtle" size="xs" className="albumDisc__label">
              Disc {disc}
            </Text>
          )}
          <ol className="catalogTracks">
            {list
              .filter((t) => (t.discNo ?? 1) === disc)
              .map((track, index) => (
                <TrackMenu track={track} key={track.path}>
                  <li className="catalogTrack">
                    {/* The tagged position where there is one, so the numbers
                        match the sleeve rather than counting what survived; a
                        rip missing track 3 should read 1, 2, 4. */}
                    <span className="catalogTrack__rank">{track.trackNo ?? index + 1}</span>
                    <button
                      type="button"
                      className="catalogTrack__title catalogTrack__title--play"
                      onClick={() => onPlay(track, list)}
                    >
                      {track.title}
                    </button>
                    {/* Only where it differs from the record's own credit -
                        which is exactly the guest that used to make this whole
                        album vanish from the artist page. */}
                    {fold(track.artist) !== fold(credit) && (
                      <span className="catalogTrack__plays">{track.artist}</span>
                    )}
                    <span className="catalogTrack__time">{formatDuration(track.duration)}</span>
                  </li>
                </TrackMenu>
              ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
