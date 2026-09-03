/**
 * The three little bars that say "this is the one playing".
 *
 * Drawn wherever a song row can be the current track - the tables, the playlist
 * rows - so the mark is the same object everywhere it appears. Accent-coloured
 * and gently bouncing; `prefers-reduced-motion` freezes them at three different
 * heights so the shape still reads as an equaliser standing still rather than a
 * row of identical ticks. Decorative, so it is hidden from the accessible tree -
 * the row already announces the playing state through `aria-current`.
 */
export function NowPlayingBars() {
  return (
    <span className="nowPlayingBars" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}
