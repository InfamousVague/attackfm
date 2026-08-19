import { useEffect, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { IconButton, Text } from '@glacier/react';
import { AudioWaveform, X } from '@glacier/icons';
import { useServerSession } from '@attackfm/app/serverSession';
import { deck, STEM_HUES, STEM_LABELS } from './engine.ts';
import { putOnDeck, trackId, type Preparing, type Session, type Song } from './openSong.ts';
import { PreparingView } from './Preparing.tsx';
import { meterFill, padFace, STEM_ICONS } from './padStyles.ts';
import { claimOutput, returnOutput, useBoard } from './usePads.ts';

/**
 * Stems, from the song you are already listening to.
 *
 * The board is a place you go; this is not. It opens over the Now Playing
 * screen on the song already on the deck, hands playback across at the second
 * it had reached, and gives you the six parts as six buttons. Closing it hands
 * the song back at the second IT reached - so the whole visit is a detour
 * through the middle of a song rather than a stop and a restart.
 *
 * Six controls and nothing else. The board has room for a search, a transport
 * and a progress bar; this has room for the thing you came for.
 */

interface Track {
  path: string;
  title: string;
  artist: string;
  duration: number | null;
}

const scrim: CSSProperties = {
  position: 'fixed',
  inset: 0,
  // Over the sheet, the strip and the nav bar - all three of which this is
  // acting on behalf of, and none of which it should have to out-index from
  // inside their stacking contexts. Hence the portal.
  zIndex: 3200,
  background: 'rgb(0 0 0 / 0.55)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'flex-end',
};

const sheet: CSSProperties = {
  background: 'var(--glacier-bg)',
  borderTop: '1px solid var(--glacier-border)',
  borderRadius: '16px 16px 0 0',
  padding: '14px 14px max(14px, env(safe-area-inset-bottom))',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
};

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 8,
  touchAction: 'none',
};

export function StemsPanel({ track, onClose }: { track: Track; onClose: () => void }) {
  const { session } = useServerSession();
  const [progress, setProgress] = useState<Preparing | null>({
    phase: 'asking',
    fraction: null,
    filed: 0,
    parts: 6,
  });
  const [problem, setProblem] = useState('');
  const cast = useBoard(track.duration ?? 0);

  /**
   * Take the song over, from where it is.
   *
   * Runs once, on open. The position comes from the app's player rather than
   * from a control here: you pressed this in the middle of a song and the
   * middle of that song is where it should carry on.
   */
  useEffect(() => {
    const id = trackId(track.path);
    if (!session || id === null) {
      setProgress(null);
      setProblem('This song is not on a server that can separate it.');
      return;
    }
    const song: Song = {
      id,
      title: track.title,
      artist: track.artist,
      duration: track.duration ?? 0,
    };
    const at = window.__attackfmStemsAt ?? 0;
    claimOutput();
    let live = true;
    void putOnDeck(session as Session, song, at, (p) => {
      if (live) setProgress(p);
    }).then((outcome) => {
      if (!live || outcome.superseded) return;
      setProgress(null);
      if (!outcome.ok) setProblem(outcome.problem ?? 'That did not work.');
      cast.refresh();
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, for this song
  }, [track.path]);

  /** Leaving gives the song back at the second the stems reached. */
  const leave = () => {
    const at = deck.position();
    deck.clear();
    returnOutput(Number.isFinite(at) && at > 0 ? at : undefined);
    cast.refresh();
    onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') leave();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return createPortal(
    <div style={scrim} role="dialog" aria-label="Stems" onClick={leave}>
      <div style={sheet} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <Text weight="bold" size="sm">
              Stems
            </Text>
            <Text
              size="xs"
              tone="muted"
              style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
            >
              {problem ||
                cast.fault ||
                (progress ? track.title : 'Tap to drop a part, hold to drop it while you hold.')}
            </Text>
          </div>
          <IconButton variant="ghost" aria-label="Close stems" onClick={leave}>
            <X size={18} />
          </IconButton>
        </div>

        {progress && !problem && <PreparingView progress={progress} compact />}

        {!progress && (
        <div style={grid} role="group" aria-label="Parts">
          {cast.stems.map((stem) => {
            const Icon = STEM_ICONS[stem] ?? AudioWaveform;
            const live = cast.on[stem] ?? false;
            return (
              <button
                key={stem}
                type="button"
                aria-pressed={live}
                aria-label={STEM_LABELS[stem] ?? stem}
                style={{ ...padFace(STEM_HUES[stem] ?? 200, live, 10), minHeight: 62 }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  try {
                    e.currentTarget.setPointerCapture(e.pointerId);
                  } catch {
                    // Some engines refuse capture for a pointer already gone.
                  }
                  cast.press(stem, e.pointerId);
                }}
                onPointerUp={(e) => cast.lift(e.pointerId)}
                onPointerCancel={(e) => cast.lift(e.pointerId)}
              >
                <span ref={cast.meterRef(stem)} style={meterFill} aria-hidden />
                <Icon size={16} style={{ opacity: live ? 1 : 0.55, position: 'relative' }} />
                <Text
                  size="xs"
                  weight="bold"
                  style={{ position: 'relative', opacity: live ? 1 : 0.6, lineHeight: 1.1 }}
                >
                  {STEM_LABELS[stem] ?? stem}
                </Text>
              </button>
            );
          })}
        </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

declare global {
  interface Window {
    /** Where the app's player had got to when Stems was pressed. Set by the
     *  button, read here - the panel mounts a frame later and the sheet does
     *  not pass a position down. */
    __attackfmStemsAt?: number;
  }
}
