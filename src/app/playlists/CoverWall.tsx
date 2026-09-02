import { useMemo } from 'react';
import { mosaicArts } from '../ux/artLoad.ts';

/**
 * The covers of a list, drifting slowly behind its header.
 *
 * A playlist's identity is the records in it, and the header says so with the
 * actual sleeves, moving, so a list looks like the music it holds before you
 * have read a word of it.
 *
 * Built to the app's front-door treatment (servers/ArtWall): a slab of columns,
 * each scrolling vertically at a different speed and in alternating directions,
 * the whole thing tilted off-square. That tilt plus the vertical drift is what
 * reads as a diagonal - the same look the sign-in wall wears, brought here so
 * the two are recognisably one thing. It replaced a single horizontal strip,
 * whose one seam this trades for four independent per-column ones.
 *
 * Each column holds its covers TWICE and travels exactly half its own height,
 * which is what makes each loop seamless: at the end of the run the second copy
 * sits exactly where the first began. `transform` only, one promoted layer per
 * column, nothing measured per frame.
 *
 * Reduced motion stops it dead rather than hiding it: the covers are the point
 * and they still read as a wall standing still.
 */

/**
 * How many sleeves the wall carries. Dealt round-robin across the columns, so
 * neighbouring columns never start on the same picture; deduped by image, so
 * this is a ceiling. No longer has to divide by anything - each column loops on
 * its own, so the old "multiple of the row count" seam constraint is retired.
 */
const WALL_COVERS = 20;

/** Below this there is no wall to be had - one sleeve tiled is wallpaper. */
const WALL_MINIMUM = 3;

/** Four columns, four durations that never line up - columns sharing a period
 *  would pulse together instead of drifting. Slow on purpose. */
const DURATIONS = ['46s', '55s', '64s', '73s'];
const COLUMNS = DURATIONS.length;

/** Deal the covers round-robin into the columns. */
function toColumns(covers: readonly string[]): string[][] {
  const out: string[][] = Array.from({ length: COLUMNS }, () => []);
  covers.forEach((src, i) => out[i % COLUMNS]!.push(src));
  return out;
}

export function CoverWall({
  artworks,
  loading = 'lazy',
}: {
  artworks: readonly (string | null)[];
  /**
   * Lazy behind a header, where the wall is one band of a page that scrolls
   * past it. Eager where the wall IS the page (the registry's playlist link
   * page hangs it behind everything): there is nothing to defer for, and a
   * lazy wall that never intersects - a hidden tab, a browser that will not
   * observe through a filtered, transformed slab - is a wall that never draws.
   */
  loading?: 'lazy' | 'eager';
}) {
  // 160, not 640: this is blurred past the point where detail survives.
  const covers = useMemo(() => mosaicArts(artworks, WALL_COVERS, 160), [artworks]);
  const cols = useMemo(() => toColumns(covers), [covers]);
  // A column of one cover tiled is wallpaper; keep the minimum on the whole set.
  if (covers.length < WALL_MINIMUM) return null;

  return (
    <div className="coverWall" aria-hidden="true">
      <div className="coverWall__slab">
        {cols.map((column, i) => (
          <div
            key={i}
            className="coverWall__col"
            data-dir={i % 2 === 0 ? 'up' : 'down'}
            style={{ ['--wall-dur' as string]: DURATIONS[i] }}
          >
            {/* Twice through: the animation travels -50%, so the copy lands
                where the original started and the seam never shows. Map the same
                slice again rather than anything that might reorder it. */}
            {[...column, ...column].map((src, j) => (
              <img key={j} src={src} alt="" loading={loading} decoding="async" />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
