import { useMemo } from 'react';

/**
 * The moving wall of album art behind the app's front door - the same treatment
 * attack.fm wears, so the site and the first screen of the app are recognisably
 * one thing.
 *
 * Four columns of covers, alternating up and down at four durations that never
 * line up, the whole slab rotated off-square and blurred back until it is
 * texture rather than pictures. Each column holds its covers TWICE and travels
 * exactly half its own height, which is what makes the loop seamless: at the
 * end of the run the second copy is sitting exactly where the first began.
 *
 * The art is bundled rather than drawn from the listener's library on purpose -
 * this shows before anyone has signed in, when there is no library to draw
 * from. Dropping a file into src/assets/wall picks it up; nothing here lists
 * them by name.
 */

// Eager so the covers are part of the bundle graph and land as ordinary hashed
// assets - a lazy glob would fetch them one by one over a connection the gate
// cannot assume it has.
const COVERS = Object.entries(
  import.meta.glob<string>('../assets/wall/*.jpg', { eager: true, query: '?url', import: 'default' }),
)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([, url]) => url);

/** How long each column takes to travel its own half-height. Deliberately
 *  co-prime-ish and slow: four columns that share a period would pulse. */
const DURATIONS = ['46s', '55s', '64s', '73s'];
const COLUMNS = DURATIONS.length;

/** Deal the covers round-robin into the columns, so neighbouring columns never
 *  start on the same picture. */
function columns(covers: readonly string[]): string[][] {
  const out: string[][] = Array.from({ length: COLUMNS }, () => []);
  covers.forEach((src, i) => out[i % COLUMNS]!.push(src));
  return out;
}

export function ArtWall() {
  const cols = useMemo(() => columns(COVERS), []);
  if (COVERS.length === 0) return null;
  return (
    <div className="artWall" aria-hidden="true">
      {cols.map((covers, i) => (
        <div
          key={i}
          className="artWall__col"
          data-dir={i % 2 === 0 ? 'up' : 'down'}
          style={{ ['--wall-dur' as string]: DURATIONS[i] }}
        >
          {/* Twice through: the animation travels -50%, so the copy lands where
              the original started and the seam never shows. */}
          {[...covers, ...covers].map((src, j) => (
            <img key={j} src={src} alt="" loading="eager" decoding="async" />
          ))}
        </div>
      ))}
    </div>
  );
}
