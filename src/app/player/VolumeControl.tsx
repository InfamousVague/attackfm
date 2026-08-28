import { useRef } from 'react';
import { fireFelt } from '../core/haptics.ts';
import { IconButton, Popover, Slider, volumeGain } from '@glacier/react';
import { Volume2, VolumeX } from '@glacier/icons';
import { usePlayback } from './playback.tsx';

/** Unity (0 dB) sits at 100; the fader runs on to 150 for a boost region. */
export const VOLUME_UNITY = 100;
export const VOLUME_MAX = 150;
// How far past unity the thumb must be dragged before it leaves the detent.
const DETENT_RADIUS = 6;

/** Snaps the fader to unity within a small band, so 100% takes a deliberate
 * extra drag to pass rather than being easy to skim over. */
export function snapToUnity(value: number): number {
  return Math.abs(value - VOLUME_UNITY) <= DETENT_RADIUS ? VOLUME_UNITY : value;
}

/**
 * The detent, in the hand.
 *
 * `snapToUnity` is a real magnetic notch - the thumb clamps to unity and takes
 * a deliberate extra drag to leave - and it was drawn on screen and felt
 * nowhere. A fader that catches is a physical claim, and the finger is the
 * sense that should be told.
 *
 * Returns the snapped value and fires on the EDGE only. Inside the band every
 * event returns unity, so an unguarded fire buzzes continuously while a thumb
 * rests there: the machine-gun this whole pass is trying to avoid.
 */
function useUnityDetent() {
  const snapped = useRef(false);
  return (next: number) => {
    const value = snapToUnity(next);
    const inside = value === VOLUME_UNITY && next !== VOLUME_UNITY;
    if (inside && !snapped.current) fireFelt('light');
    snapped.current = inside;
    return value;
  };
}

// dB below unity comes from the kit's own calibration; above it the boost is a
// straight amplitude ratio (150 => 1.5x => +3.5 dB).
function readoutFor(value: number, muted: boolean): string {
  if (muted || value <= 0) return '\u2212\u221E dB';
  const db = value <= VOLUME_UNITY ? volumeGain(value) : 20 * Math.log10(value / VOLUME_UNITY);
  const rounded = Math.round(db * 10) / 10;
  return `${rounded > 0 ? '+' : ''}${rounded} dB`;
}

interface VolumeControlProps {
  /** 0-150 fader position; 100 is unity, above it is boost. */
  value: number;
  muted: boolean;
  onValueChange: (value: number) => void;
  onMutedChange: (muted: boolean) => void;
}

/**
 * The player's volume: a mute button that opens a vertical fader on hover. The
 * fader runs past unity into a boost region, marks unity with a line, and sticks
 * there until dragged clear. Replaces the kit VolumeBar, which stops at 100.
 *
 * Muting drops the fader to the floor rather than freezing and greying it: the
 * fader should read what is coming out, and while muted nothing is. The level
 * itself is untouched underneath, so unmuting puts the fader back exactly where
 * it was rather than at some default - and the fader stays live while muted,
 * since reaching for it is the clearest way of saying you want to hear again.
 */
/**
 * The same fader laid flat in a row - for the phone's overflow panel, where a
 * hover-opened popover has no hover to open on and a second popover under the
 * first would stack sheets. Same math, same detent, same readout; only the
 * geometry changes.
 */
export function VolumeRow({ value, muted, onValueChange, onMutedChange }: VolumeControlProps) {
  const detent = useUnityDetent();
  // With boost off the fader simply ends at unity: no boost region, no detent
  // line to mark where it would have started.
  const { volumeBoost } = usePlayback();
  const shown = muted ? 0 : value;
  return (
    <div className="volRow">
      <IconButton
        variant="ghost"
        size="sm"
        aria-label={muted ? 'Unmute' : 'Mute'}
        aria-pressed={muted}
        onClick={() => onMutedChange(!muted)}
      >
        {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
      </IconButton>
      <div className="volRowRailWrap">
        {/* The unity (100%) line the fader detents against, upright against a
            horizontal travel. */}
        {volumeBoost && <span className="volRowUnityTick" aria-hidden="true" />}
        <Slider
          className="volRowRail"
          min={0}
          max={volumeBoost ? VOLUME_MAX : VOLUME_UNITY}
          value={shown}
          aria-label="Volume"
          aria-valuetext={readoutFor(shown, muted)}
          onValueChange={(next) => {
            if (muted) onMutedChange(false);
            onValueChange(detent(next));
          }}
        />
      </div>
      <span className="volReadout">{readoutFor(shown, muted)}</span>
    </div>
  );
}

export function VolumeControl({ value, muted, onValueChange, onMutedChange }: VolumeControlProps) {
  const detent = useUnityDetent();
  const { volumeBoost } = usePlayback();
  const shown = muted ? 0 : value;
  return (
    <Popover
      placement="top"
      openOn="hover"
      aria-label="Volume"
      className="volPanel"
      trigger={
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={muted ? 'Unmute' : 'Mute'}
          aria-pressed={muted}
          onClick={() => onMutedChange(!muted)}
        >
          {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
        </IconButton>
      }
    >
      <div className="volBody">
        <div className="volRailWrap">
          {/* The unity (100%) line the fader detents against. */}
          {volumeBoost && <span className="volUnityTick" aria-hidden="true" />}
          <Slider
            className="volRail"
            orientation="vertical"
            min={0}
            max={volumeBoost ? VOLUME_MAX : VOLUME_UNITY}
            value={shown}
            aria-label="Volume"
            aria-valuetext={readoutFor(shown, muted)}
            onValueChange={(next) => {
              // Moving a fader that is putting out nothing is a request to hear
              // something, so the mute lifts and the level it lands on is the
              // one that plays.
              if (muted) onMutedChange(false);
              onValueChange(detent(next));
            }}
          />
        </div>
        <span className="volReadout">{readoutFor(shown, muted)}</span>
      </div>
    </Popover>
  );
}
