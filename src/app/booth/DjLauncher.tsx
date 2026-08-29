//! The DJ, on the client: one button, no brief. The server hands back a
//! continuous set drawn from what the listener actually plays, with a spoken
//! line opening each run; this turns that into playback - the whole set
//! becomes the queue, and the lines FLOAT: each one arrives as a dismissable
//! card when its run begins, the way a radio DJ talks over the intro, rather
//! than as a strip of small italic text wedged into the library header.
//!
//! There was a vibe field here. It asked the listener to have an idea before
//! they could hear anything, which is the opposite of what a DJ button is for:
//! the point is to press it and be played to. The server's own taste model is a
//! better answer than most people's first typed word, and it already mixes the
//! less-played corners of a library in rather than looping the same favourites.
//!
//! Draws on the server library and the listener's play history, so it only
//! offers itself when signed into a server with something to play.

import { Button, Spinner } from '@glacier/react';
import { Flame, Lightbulb, MoonStar, Play, Sparkles, Waves } from '@glacier/icons';
import { useState, type CSSProperties } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { useLibrary } from '../library/library.tsx';
import { startDjRun } from './djSession.ts';
import { DjToast } from './DjSetBridge.tsx';
import { LibChipMosaic, LibChipStat } from '../library/LibChipFace.tsx';
import type { Track } from '../core/tauri.ts';
import djMascot from '../../assets/dj-mascot.webp';

/** The Booth's steering row: each chip is a whole brief, one tap from sound.
 *  The seeds mirror the server's own mood-mix recipes, so the chip and the
 *  curated shelf speak the same dialect. */
export const MOODS: { label: string; seed: string; Icon: typeof Waves }[] = [
  { label: 'Chill', seed: 'something chill and unhurried', Icon: Waves },
  { label: 'Energy', seed: 'high energy, turn it up', Icon: Flame },
  { label: 'Late night', seed: 'late night, low lights', Icon: MoonStar },
  { label: 'Focus', seed: 'steady focus, no distractions', Icon: Lightbulb },
];

export function DjLauncher({
  onPlay,
  variant = 'chip',
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  /** 'chip' is the Library's whole-collection door; 'hero' is the Booth's
   *  drop-the-needle card with the mood chips underneath. */
  variant?: 'chip' | 'hero';
}) {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  // Which brief is in flight: '' is the seedless hero press, null is idle.
  const [busySeed, setBusySeed] = useState<string | null>(null);
  const [aiSet, setAiSet] = useState(false);
  // Errors only: the set's own lines toast from DjSetBridge, app-wide, so
  // they keep arriving after this page (and this component) are gone.
  const [toast, setToast] = useState<string | null>(null);
  const busy = busySeed !== null;

  // The DJ reads a server library and a listening history; without either there
  // is nothing for it to spin.
  if (!session || tracks.length === 0) return null;

  const start = async (seed = '') => {
    setBusySeed(seed);
    setToast(null);
    try {
      const { queue, ai } = await startDjRun(session, tracks, seed);
      setAiSet(ai);
      const opener = queue[0];
      if (!opener) {
        setToast('The DJ came up empty. Play a few things first so it learns your taste.');
        return;
      }
      // The run is already published; the bridge toasts the opener's line and
      // speaks its beats the moment this lands as the playing track.
      onPlay(opener, queue);
    } catch (err) {
      setToast(err instanceof Error ? err.message : 'The DJ could not start.');
    } finally {
      setBusySeed(null);
    }
  };

  // The Booth's face: one hero that IS the brief, and a row of moods that
  // steer it - every chip a whole request, no field to fill first.
  if (variant === 'hero') {
    return (
      <>
        <Button
          type="button"
          variant="gradient"
          fullWidth
          className="boothHero"
          onClick={() => void start()}
          disabled={busy}
          aria-label="Start a set from your taste"
        >
          <span className="boothHero__disc" aria-hidden="true">
            {busySeed === '' ? (
              <Spinner size="sm" aria-label="Cueing" />
            ) : (
              <Play size={22} fill="currentColor" />
            )}
          </span>
          <span className="boothHero__text">
            <span className="boothHero__title">
              Drop the needle
              {aiSet && <Sparkles size={14} className="boothHero__spark" aria-hidden="true" />}
            </span>
            <span className="boothHero__caption">A live set, built from what you play</span>
          </span>
        </Button>
        <div className="boothChips" role="group" aria-label="Set the mood">
          {MOODS.map(({ label, seed, Icon }) => (
            <Button
              key={label}
              type="button"
              variant={busySeed === seed ? 'solid' : 'outline'}
              size="sm"
              className="boothChip"
              data-on={busySeed === seed || undefined}
              disabled={busy}
              onClick={() => void start(seed)}
            >
              {busySeed === seed ? <Spinner size="sm" aria-label="Cueing" /> : <Icon size={14} />}
              {label}
            </Button>
          ))}
        </div>
        {toast && <DjToast line={toast} onDismiss={() => setToast(null)} />}
      </>
    );
  }

  // The chip: the DJ standing beside Liked and All songs, in their row and
  // their clothes - the same gradient face and name-over-line the library's
  // other two whole-collection doors wear. Pressing it IS the brief.
  return (
    <>
      <Button
        type="button"
        variant="gradient"
        className="libChip libChip--dj"
        style={{ '--libChipHue': 265, '--libChipHue2': 315, '--art': `url("${djMascot}")` } as CSSProperties}
        onClick={() => void start()}
        disabled={busy}
        aria-label="Start the DJ"
      >
        <img className="libChip__art" src={djMascot} alt="" loading="lazy" />
        {/* The DJ has no fixed collection - it wears the whole library's
            sleeves for Real covers, and an infinity for Numbers first, because
            the set it spins is never the same twice. */}
        <LibChipMosaic covers={tracks.map((t) => t.artwork).filter((a): a is string => !!a)} />
        <LibChipStat value="∞" glyph />
        <span className="libChip__name">DJ</span>
        <span className="libChip__count">
          {busy ? <Spinner size="sm" aria-label="Cueing" /> : 'A live set, from your taste'}
        </span>
      </Button>
      {toast && <DjToast line={toast} onDismiss={() => setToast(null)} />}
    </>
  );
}
