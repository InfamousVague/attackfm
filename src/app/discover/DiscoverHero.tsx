import { Button } from '@glacier/react';
import { ListMusic, Play } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { CoverWall } from '../playlists/CoverWall.tsx';
import { EdgeScrollRow } from '../ux/EdgeScrollRow.tsx';
import { useLoopArt } from '../ux/loopArt.ts';
import { useLibrary } from '../library/library.tsx';
import { fetchCanvas } from '../server.ts';
import { useDiscoverFeed } from '../home/DiscoverFeed.tsx';
import type { HeroLead } from './heroLead.ts';
import type { Track } from '../core/tauri.ts';
import type { SongCollection } from '../library/SongPage.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

/**
 * The top of Discover: one thing, big, wearing its music.
 *
 * The page used to open on two gradient chips and a rail of small squares.
 * It opens on art now - the same band the Music header and every collection
 * page wear (`.songPageHead`), which runs up behind the title bar and down to
 * the first shelf, with one kicker, one title, one blurb and one row of
 * actions resting on it. All songs is a door in the row; Music Date is the card
 * under the hero (it was a pill here, and was too hidden). The chips' doors are
 * that row.
 *
 * What it LEADS with is settled next door, in `heroLead.ts`: the newest thing
 * the machine has for you, the daylist, or - when there is neither - the
 * library itself. The page hands the answer in, because the shelves below
 * have to know it too, to keep from showing the same list an inch further on.
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

export function DiscoverHero({
  lead,
  onPlay,
  onOpenSongs,
}: {
  lead: HeroLead;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenSongs: (view: SongCollection) => void;
}) {
  const t = useT();
  const { session, clips, wallSettled, openList } = useDiscoverFeed();
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the song's name, not the lead object's identity: a re-made lead carrying the same first song must not re-ask for its Canvas.
  }, [session, wall, wallSettled, first?.title, first?.artist]);

  const face: 'wall' | 'canvas' | 'mosaic' = wall ? 'wall' : canvas ? 'canvas' : 'mosaic';

  return (
    // `data-testid`, and the only one on this page: the hero's kicker, title
    // and blurb are three plain spans with no role between them - the words
    // over a picture - and the end-to-end suite has to be able to say WHICH
    // of the three leads (`heroLead.ts`) is on screen. The alternative was
    // pinning the suite to `.discoverHead` or to `data-face`, both of which
    // the stylesheet owns; this is a handle that belongs to nobody else.
    <header className="playlistHead songPageHead discoverHead" data-face={face} data-testid="discover-hero">
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
              <span>{t('common.open')}</span>
            </Button>
          )}
          {lead.kind === 'daylist' && lead.tracks && lead.tracks.length > 0 && (
            <Button variant="solid" size="sm" onClick={() => onPlay(lead.tracks![0]!, lead.tracks!)}>
              <Play size={14} />
              <span>{t('player.play')}</span>
            </Button>
          )}
          <Button variant="glass" size="sm" onClick={() => onOpenSongs('all')}>
            <span>{t('library.allSongs')}</span>
          </Button>
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
