/**
 * How large the whole interface draws - the one number, and its bounds.
 *
 * Beside `appearance.tsx` rather than inside it because this is the guard on a
 * value that arrives from OUTSIDE the app: localStorage, hand-edited or
 * written by an older build. The provider applies the number to the root font
 * size, so a NaN or a 40 here is not a wrong-looking setting, it is an app
 * nobody can use - which makes the clamp worth pinning on its own.
 */

/** What the setting offers, smallest first. Steps rather than a slider: a
 *  number that only ever lands on a known value is one that can be reasoned
 *  about, and every one of these has been looked at. */
export const UI_SCALES = [0.85, 0.925, 1, 1.1, 1.25] as const;

const MIN_SCALE = UI_SCALES[0]!;
const MAX_SCALE = UI_SCALES[UI_SCALES.length - 1]!;

/** A stored or chosen scale, made safe: a number in range, or normal. */
export function clampScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
}
