/**
 * The station mark's silhouette, as numbers.
 *
 * Two renderers draw this wave: the in-app `BeatWave` component, which
 * deforms it with the beat, and `dockWave.ts`, which strokes it onto a canvas
 * for the macOS Dock. Neither is allowed its own copy of the shape - a drift
 * between them shows up months later as "the dock icon looks a bit off" - so
 * the geometry lives here, on its own, with no React around it.
 */

/**
 * The mark's silhouette as (u, dy) control points: u across the wave 0..1,
 * dy the offset from the midline in viewBox units (negative is up). Traced
 * off the 1024px asset - flat lead-in, the small hump, the big peak, the
 * deep dip, and the little upward hook the tail ends on.
 */
const SHAPE: readonly (readonly [number, number])[] = [
  // Doubled flat points pin the lead-in level before the first hump rises.
  [0, 0.5],
  [0.045, 0.5],
  [0.09, 0.5],
  [0.165, -3.5],
  [0.245, -11.5],
  [0.34, -1.5],
  [0.435, 9.5],
  [0.53, -5.5],
  [0.625, -26],
  [0.725, -9.5],
  [0.81, 15],
  [0.885, 8.5],
  [0.95, -1],
  [1, -2.5],
];

/** How many segments each run is drawn as; at icon sizes the corners vanish. */
export const SAMPLES = 72;

/** Where the midline sits and how the static shadow hangs off the mark, in
 *  viewBox units. */
export const WAVE_MID_Y = 54;
export const WAVE_SHADOW_DROP = 3;

export const clamp01 = (n: number): number =>
  Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0;

/** The control point at a clamped index - the ends repeat, which is what
 * Catmull-Rom wants at a curve's edges anyway. */
function point(i: number): readonly [number, number] {
  return SHAPE[Math.min(SHAPE.length - 1, Math.max(0, i))] ?? [0, 0];
}

/** Catmull-Rom through the control points, sampled at u. */
export function baseOffset(u: number): number {
  const t = clamp01(u);
  let i = SHAPE.length - 2;
  for (let k = 1; k < SHAPE.length; k += 1) {
    if (t <= point(k)[0]) {
      i = k - 1;
      break;
    }
  }
  const p0 = point(i - 1);
  const p1 = point(i);
  const p2 = point(i + 1);
  const p3 = point(i + 2);
  const span = p2[0] - p1[0] || 1;
  const s = (t - p1[0]) / span;
  const s2 = s * s;
  const s3 = s2 * s;
  return (
    0.5 *
    (2 * p1[1] +
      (p2[1] - p0[1]) * s +
      (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * s2 +
      (p3[1] - p0[1] + 3 * (p1[1] - p2[1])) * s3)
  );
}

/**
 * The mark's silhouette at a given swell, sampled as (x, dy) pairs in the
 * 0..100 viewBox: x across the wave, dy the offset from the midline. The dock
 * icon's frame renderer draws from this so the icon and the in-app mark are
 * the same wave at every energy level.
 */
export function sampleWave(swell: number, samples = SAMPLES): Array<readonly [number, number]> {
  const points: Array<readonly [number, number]> = [];
  for (let k = 0; k <= samples; k += 1) {
    const u = k / samples;
    points.push([8 + u * 84, baseOffset(u) * swell]);
  }
  return points;
}
