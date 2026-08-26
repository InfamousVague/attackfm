import { IconButton, SeekBar } from '@glacier/react';
import { Heart, Pause, Play, SkipBack, SkipForward } from '@glacier/icons';
import { formatClock } from '../ux/format.ts';

/**
 * The home-screen widget, drawn with the app's own components.
 *
 * This is never on screen. It is mounted off-canvas, photographed by
 * `shot.ts`, and the picture is what the launcher shows - see that file for
 * why a widget cannot run any of this directly.
 *
 * Because it IS the kit, the scrubber here is the SAME SeekBar the Now Playing
 * screen wears, with the same shape and tone, and the transport is the same
 * IconButton. Nothing is a lookalike: a change to the kit changes the widget.
 *
 * WHAT IS DELIBERATELY DIFFERENT from the player:
 *
 *  - No glass. `backdrop-filter` has nothing to filter inside an SVG, and a
 *    home screen has nothing behind the plate to show through in any case, so
 *    every surface here is solid.
 *  - No beat. The bar's swell is driven by live levels on the real screen; a
 *    photograph has no time axis, so `intensity` is 0 and the wave sits still
 *    at its resting shape.
 *  - The buttons are drawn but never pressed. Presses arrive natively, on
 *    invisible targets the launcher lays over this picture, so the geometry
 *    below is a CONTRACT with widget_shot.xml - see FACE_GEOMETRY.
 */

export type WidgetFaceName = 'compact' | 'medium' | 'large';

export interface WidgetFaceProps {
  face: WidgetFaceName;
  title: string;
  artist: string;
  /** The third line: a book's chapter. Empty for a song. */
  line?: string;
  /** Object URL or http URL for the cover; inlined before the photograph. */
  art?: string | null;
  playing: boolean;
  positionSecs: number;
  durationSecs: number;
  /** Null when the library has not said, which keeps the heart off the face. */
  favourite: boolean | null;
}

/*
 * WHERE THE BUTTONS ARE, as fractions of the face.
 *
 * The launcher cannot read this picture, so it lays invisible tap targets over
 * it from a layout of its own. These numbers are the seam between the two, and
 * they are here rather than there because this file is the one that decides
 * where a button ends up. widget_shot.xml quotes them back; changing a face's
 * arrangement means changing both, and the comment in each file says so.
 */
export const FACE_GEOMETRY: Record<
  WidgetFaceName,
  { transportTop: number; transportHeight: number; heart: 'none' | 'left' | 'right' }
> = {
  // The row's controls sit in the row itself, at the trailing end.
  compact: { transportTop: 0, transportHeight: 1, heart: 'none' },
  medium: { transportTop: 0.56, transportHeight: 0.44, heart: 'right' },
  large: { transportTop: 0.78, transportHeight: 0.22, heart: 'left' },
};

export function WidgetFace({
  face,
  title,
  artist,
  line,
  art,
  playing,
  positionSecs,
  durationSecs,
  favourite,
}: WidgetFaceProps) {
  const bar = durationSecs > 0 && (
    <SeekBar
      duration={durationSecs}
      value={Math.min(positionSecs, durationSecs)}
      aria-label="Seek"
      shape="swell"
      tone="accent"
      fill="solid"
      rail="contrast"
      // A photograph has no beat to swell to; the resting shape is the honest
      // one, and a bar frozen mid-pulse would read as a rendering fault.
      intensity={0}
    />
  );
  const clocks = durationSecs > 0 && (
    <div className="wface__times">
      <span>{formatClock(positionSecs)}</span>
      <span>-{formatClock(Math.max(0, durationSecs - positionSecs))}</span>
    </div>
  );
  const cover = (
    <div className="wface__art">
      {art ? <img src={art} alt="" /> : <div className="wface__artEmpty" />}
    </div>
  );
  const heart = favourite == null ? null : (
    <IconButton variant="ghost" aria-label="Favourite" data-on={favourite || undefined}>
      <Heart size={face === 'large' ? 20 : 18} fill={favourite ? 'currentColor' : 'none'} />
    </IconButton>
  );
  const transport = (
    <div className="wface__transport">
      <IconButton variant="ghost" aria-label="Previous">
        <SkipBack size={face === 'compact' ? 18 : 22} fill="currentColor" />
      </IconButton>
      <span className="wface__disc" data-playing={playing || undefined}>
        {playing ? <Pause size={face === 'large' ? 26 : 22} fill="currentColor" />
                 : <Play size={face === 'large' ? 26 : 22} fill="currentColor" />}
      </span>
      <IconButton variant="ghost" aria-label="Next">
        <SkipForward size={face === 'compact' ? 18 : 22} fill="currentColor" />
      </IconButton>
    </div>
  );

  const words = (
    <div className="wface__words">
      <span className="wface__title">{title}</span>
      <span className="wface__artist">{artist}</span>
      {line ? <span className="wface__line">{line}</span> : null}
    </div>
  );

  if (face === 'compact') {
    return (
      <div className="wface" data-face="compact">
        <div className="wface__row">
          {cover}
          {words}
          {transport}
        </div>
        {bar}
      </div>
    );
  }

  if (face === 'medium') {
    return (
      <div className="wface" data-face="medium">
        <div className="wface__row">
          {cover}
          {words}
          {heart}
        </div>
        <div className="wface__scrub">
          {bar}
          {clocks}
        </div>
        {transport}
      </div>
    );
  }

  return (
    <div className="wface" data-face="large">
      {cover}
      {words}
      <div className="wface__scrub">
        {bar}
        {clocks}
      </div>
      <div className="wface__transport wface__transport--wide">
        {heart}
        <IconButton variant="ghost" aria-label="Previous">
          <SkipBack size={22} fill="currentColor" />
        </IconButton>
        <span className="wface__disc" data-playing={playing || undefined}>
          {playing ? <Pause size={26} fill="currentColor" /> : <Play size={26} fill="currentColor" />}
        </span>
        <IconButton variant="ghost" aria-label="Next">
          <SkipForward size={22} fill="currentColor" />
        </IconButton>
        <span className="wface__spacer" />
      </div>
    </div>
  );
}
