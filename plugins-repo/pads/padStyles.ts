import type { CSSProperties } from 'react';
import { AudioWaveform, Drum, Guitar, Mic, Piano, Waves } from '@glacier/icons';

/** One glyph per part, so a board can be read without reading it. */
export const STEM_ICONS: Record<string, typeof Mic> = {
  vocals: Mic,
  drums: Drum,
  bass: Waves,
  guitar: Guitar,
  piano: Piano,
  other: AudioWaveform,
};

/**
 * A pad's face, lit or out.
 *
 * Shared by the board and by the tight panel on the Now Playing screen: they
 * are the same control at two sizes, and a part that is out should look out in
 * exactly the same way in both places.
 */
export const padFace = (hue: number | null, on: boolean, pad = 12): CSSProperties => ({
  position: 'relative',
  overflow: 'hidden',
  borderRadius: 12,
  border: '1px solid var(--glacier-border)',
  background:
    hue === null
      ? 'var(--glacier-surface)'
      : on
        ? `linear-gradient(155deg, hsl(${hue} 62% 46%), hsl(${hue} 55% 28%))`
        : `linear-gradient(155deg, hsl(${hue} 22% 18%), var(--glacier-surface))`,
  color: hue !== null && on ? '#fff' : 'var(--glacier-text)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 4,
  padding: pad,
  cursor: hue === null ? 'default' : 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTapHighlightColor: 'transparent',
  // `none`, not `manipulation`: manipulation still lets the browser own pan and
  // pinch, and on a grid of targets that is how a second finger gets swallowed
  // by a scroll gesture instead of playing.
  touchAction: 'none',
  opacity: hue === null ? 0.4 : 1,
  transition: 'background 140ms ease, color 140ms ease',
});

/** The part's own loudness, painted up the pad from the floor. Composited - a
 *  transform, never a height - because it moves every frame. */
export const meterFill: CSSProperties = {
  position: 'absolute',
  inset: 'auto 0 0 0',
  height: '100%',
  transformOrigin: 'bottom',
  transform: 'scaleY(0)',
  background: 'currentColor',
  opacity: 0.16,
  pointerEvents: 'none',
};

export const seekRail: CSSProperties = {
  position: 'relative',
  height: 6,
  borderRadius: 3,
  background: 'var(--glacier-border)',
  cursor: 'pointer',
  marginTop: 6,
  touchAction: 'none',
};
