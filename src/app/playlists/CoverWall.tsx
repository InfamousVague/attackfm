import { useMemo } from 'react';
import { mosaicArts } from '../ux/artLoad.ts';

/**
 * The covers of a list, drifting slowly behind its header.
 *
 * A playlist's identity is the records in it, and until now the header said so
 * with one static quadrant tile. This is the rest of that idea: the actual
 * sleeves, moving, so a list looks like the music it holds before you have
 * read a word of it.
 *
 * Built to cost almost nothing per frame, because the last thing this app
 * needed was another animation - the accelerometer parallax came out of the
 * player for exactly that reason. The whole effect is ONE transform animation
 * on ONE element:
 *
 *   - The strip holds its covers twice and travels exactly -50%, so the second
 *     copy is under the first when it wraps and the loop has no seam. No JS
 *     runs per frame, and nothing is measured.
 *   - `transform` only. The blur is a static filter, rasterised into the layer
 *     once and then just moved - it is a blur whose RADIUS changes per frame
 *     that is expensive, not a blur.
 *   - The strip is taller and wider than the frame that clips it, so the blur's
 *     own soft edges fall outside the visible box instead of drawing a band of
 *     grey across the top and bottom of the header.
 *
 * Reduced motion stops it dead rather than hiding it: the covers are the point
 * and they still read as a wall standing still. That is also why this is an
 * animation and not a transition - there is nothing to interrupt.
 */

/**
 * How many sleeves the wall carries.
 *
 * Enough that a full playlist does not visibly repeat within a pass, few
 * enough that a three-song list is not the same cover fourteen times. They are
 * deduped by picture, so this is a ceiling and not a promise.
 */
const WALL_COVERS = 14;

/** Below this there is no wall to be had - one sleeve tiled is wallpaper. */
const WALL_MINIMUM = 3;

export function CoverWall({ artworks }: { artworks: readonly (string | null)[] }) {
  // 160, not 640: this is blurred past the point where detail survives.
  const covers = useMemo(() => mosaicArts(artworks, WALL_COVERS, 160), [artworks]);
  if (covers.length < WALL_MINIMUM) return null;

  return (
    <div className="coverWall" aria-hidden="true">
      <div className="coverWall__strip">
        {/* Twice, in order. The duplicate is what makes -50% seamless, so the
            two halves have to stay identical - map the same array again rather
            than anything that might reorder. */}
        {[...covers, ...covers].map((src, i) => (
          <img key={i} src={src} alt="" loading="lazy" decoding="async" />
        ))}
      </div>
    </div>
  );
}
