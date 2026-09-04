import { Button } from '@glacier/react';
import { Flame, ListMusic, Play } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { CoverWall } from '../playlists/CoverWall.tsx';
import { EdgeScrollRow } from '../ux/EdgeScrollRow.tsx';
import { mosaicArts } from '../ux/artLoad.ts';
import { useLoopArt } from '../ux/loopArt.ts';
import { useLibrary } from '../library/library.tsx';
import { fetchCanvas } from '../server.ts';
import { musicDateDoorOpen, openMusicDate } from '../nav/musicDateDoor.ts';
import { useDiscoverFeed, type DiscoverFeedValue } from '../home/DiscoverFeed.tsx';
import { newForYouLists, newMusicCovers } from '../library/NewMusicShelf.tsx';
import type { NewMusicList } from '../api/newMusic.ts';
import type { Track } from '../core/tauri.ts';
import type { SongCollection } from '../library/SongPage.tsx';

/**
 * The top of Discover: one thing, big, wearing its music.
 *
 * The page used to open on two gradient chips and a rail of small squares.
 * It opens on art now - the same band the Music header and every collection
 * page wear (`.songPageHead`), which runs up behind the title bar and down to
 * the first shelf, with one kicker, one title, one blurb and one row of
 * actions resting on it. The chips' two doors (All songs, Music Date) are
 * that row.
 *
 * What it LEADS with is the newest thing the machine has for you: the first
 * "New for you" list, or - on a hub with no model to build one - the daylist,
 * the one card that moves with the clock. Neither yet (a fresh account, a
 * curator still reading) and it leads with the library itself.
 *
 * What it WEARS is decided in order of how much it moves:
 *   1. the wall - this listener's own Canvas clips, when the hub has at least
 *      two (the sleeves fill in behind them, exactly as the Music header);
 *   2. one Canvas clip for the lead's first song, asked for by title and
 *      artist the way a Date card asks, which works for songs not on the box;
 *   3. the lead's own covers, as a mosaic filling the band.
 * Each face has the words over it; the wall keeps the page's own text colour
 * because its mask already holds the title legible in both themes, and the
 * two full-bleed faces put a scrim under white type instead.
 */

/** What the hero leads with. Exported so the page can keep the shelves from
 *  showing the same list an inch below it. */
export interface HeroLead {
  kind: 'list' | 'daylist' | 'library';
  kicker: string;
  title: string;
  blurb: string;
  /** Sleeves for the mosaic and the wall's posters. */
  covers: string[];
  /** The song a single Canvas is asked for. */
  first: { title: string; artist: string } | null;
  list?: NewMusicList;
  tracks?: Track[];
}

export function heroLead(feed: DiscoverFeedValue, library: Track[]): HeroLead {
  const list = newForYouLists(feed.newMusic)[0];
  if (list) {
    const first = list.items[0];
    return {
      kind: 'list',
      kicker: 'New for you',
      title: list.title,
      blurb: list.blurb || `${list.items.length} songs you do not own yet`,
      covers: newMusicCovers(list, 4),
      first: first ? { title: first.title, artist: first.artist } : null,
      list,
    };
  }
  const daylist = feed.home.daylist;
  if (daylist) {
    const first = daylist.tracks[0];
    return {
      kind: 'daylist',
      kicker: daylist.title,
      title: daylist.subtitle,
      blurb: daylist.blurb,
      covers: mosaicArts(daylist.tracks.map((t) => t.artwork), 4, 640),
      first: first ? { title: first.title, artist: first.artist } : null,
      tracks: daylist.tracks,
    };
  }
  return {
    kind: 'library',
    kicker: 'Discover',
    title: 'Your library, read back to you',
    blurb:
      library.length > 0
        ? 'Play a few songs and this page starts learning what you like.'
        : 'Add music and this page fills with what it finds for you.',
    covers: mosaicArts(library.map((t) => t.artwork), 4, 640),
    first: null,
  };
}

export function DiscoverHero({
  lead,
  onPlay,
  onOpenSongs,
}: {
  lead: HeroLead;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenSongs: (view: SongCollection) => void;
}) {
  const { session, clips, wallSettled, openList, auditions } = useDiscoverFeed();
  const { tracks } = useLibrary();
  // A hidden tab pauses the clip; this puts it back when the tab returns.
  useLoopArt();

  // The wall: the lead's sleeves first, then the library's, so the posters
  // behind the clips are the music this band is about. 160px variants - the
  // wall is blurred past detail and would otherwise fetch twenty full sleeves.
  const wallArt = useMemo(
    () => [...lead.covers, ...tracks.map((t) => t.artwork)],
    [lead.covers, tracks],
  );
  const wall = clips.length >= 2;

  // One Canvas for the lead's first song, asked for only once the wall has
  // answered "none": a hub with clips never pays for this, and a hub without
  // them asks once per lead. Nothing is warmed ahead - this is the one card.
  const [canvas, setCanvas] = useState<string | null>(null);
  const first = lead.first;
  useEffect(() => {
    setCanvas(null);
    if (!session || wall || !wallSettled || !first) return;
    const ctrl = new AbortController();
    void fetchCanvas(session, first.title, first.artist, ctrl.signal).then((url) => {
      if (!ctrl.signal.aborted) setCanvas(url);
    });
    return () => ctrl.abort();
  }, [session, wall, wallSettled, first?.title, first?.artist]);

  const face: 'wall' | 'canvas' | 'mosaic' = wall ? 'wall' : canvas ? 'canvas' : 'mosaic';
  const dateOpen = session !== null && musicDateDoorOpen();
  const waiting = auditions.mine.length;

  return (
    <header className="playlistHead songPageHead discoverHead" data-face={face}>
      <div className="discoverHead__face">
        {face === 'wall' ? (
          <CoverWall artworks={wallArt} clips={clips} loading="eager" />
        ) : face === 'canvas' && canvas ? (
          // Muted and inline: the sound on this page is whatever is playing,
          // and a clip that fought it would be two songs at once. A fresh
          // element per clip - WebKit does not reliably restart a swapped src.
          <video
            key={canvas}
            className="discoverHero__art discoverHero__art--canvas"
            data-loop-art=""
            src={canvas}
            poster={lead.covers[0]}
            autoPlay
            loop
            muted
            playsInline
            preload="auto"
            disablePictureInPicture
            onEnded={(e) => {
              const v = e.currentTarget;
              v.currentTime = 0;
              void v.play().catch(() => {});
            }}
          />
        ) : (
          <HeroMosaic covers={lead.covers} />
        )}
      </div>
      {face !== 'wall' && <div className="discoverHero__scrim" aria-hidden />}
      <div className="playlistHead__body discoverHero__text">
        <span className="discoverHero__kicker">{lead.kicker}</span>
        <h1 className="discoverHero__title">{lead.title}</h1>
        <p className="discoverHero__blurb">{lead.blurb}</p>
        <EdgeScrollRow className="playlistHead__actions discoverHero__actions">
          {lead.kind === 'list' && lead.list && (
            <Button variant="solid" size="sm" onClick={() => openList(lead.list!)}>
              <ListMusic size={14} />
              <span>Open</span>
            </Button>
          )}
          {lead.kind === 'daylist' && lead.tracks && lead.tracks.length > 0 && (
            <Button variant="solid" size="sm" onClick={() => onPlay(lead.tracks![0]!, lead.tracks!)}>
              <Play size={14} />
              <span>Play</span>
            </Button>
          )}
          <Button variant="glass" size="sm" onClick={() => onOpenSongs('all')}>
            <span>All songs</span>
          </Button>
          {dateOpen && (
            <Button variant="glass" size="sm" onClick={openMusicDate} aria-label="Open Music Date">
              <Flame size={14} />
              <span>Music Date{waiting > 0 ? ` · ${waiting}` : ''}</span>
            </Button>
          )}
        </EdgeScrollRow>
      </div>
    </header>
  );
}

/** The lead's own sleeves, filling the band: one fills it, two split it,
 *  three give the first the tall half, four make the square. */
function HeroMosaic({ covers }: { covers: string[] }) {
  const arts = covers.slice(0, 4);
  return (
    <div className="discoverHero__art discoverHero__mosaic" data-covers={arts.length} aria-hidden>
      {arts.map((src, i) => (
        <img key={i} src={src} alt="" loading="eager" decoding="async" />
      ))}
    </div>
  );
}
