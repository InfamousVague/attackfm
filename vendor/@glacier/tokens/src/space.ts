/**
 * Fluid space scale.
 *
 * Each step interpolates between a 4px-grid value at the 320px viewport and a
 * 5px-grid value at the 1536px viewport, so spatial rhythm breathes with the
 * page while every element stays on the same shared scale.
 */

export const VIEWPORT_MIN_REM = 20; // 320px
export const VIEWPORT_MAX_REM = 96; // 1536px

export interface FluidValue {
  /** rem value at the minimum viewport */
  min: number;
  /** rem value at the maximum viewport */
  max: number;
  /** CSS clamp() expression (or a plain rem value when min === max) */
  clamp: string;
}

const round = (n: number): number => Math.round(n * 10000) / 10000;

export function fluid(minRem: number, maxRem: number): FluidValue {
  if (minRem === maxRem) {
    return { min: minRem, max: maxRem, clamp: `${round(minRem)}rem` };
  }
  const slope = (maxRem - minRem) / (VIEWPORT_MAX_REM - VIEWPORT_MIN_REM);
  const intercept = minRem - slope * VIEWPORT_MIN_REM;
  return {
    min: minRem,
    max: maxRem,
    clamp: `clamp(${round(minRem)}rem, ${round(intercept)}rem + ${round(slope * 100)}vw, ${round(maxRem)}rem)`,
  };
}

/** Step numbers: 1 unit = 4px at the min viewport, 5px at the max. */
export const SPACE_STEPS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24] as const;
export type SpaceStep = (typeof SPACE_STEPS)[number];

export const space: Record<SpaceStep, FluidValue> = Object.fromEntries(
  SPACE_STEPS.map((n) => [n, fluid(n * 0.25, n * 0.3125)]),
) as Record<SpaceStep, FluidValue>;

// ---- CSS emission ----------------------------------------------------------

/**
 * The space scale, each step multiplied by the density knob so padding and
 * gaps breathe with data-density. space-px stays a true pixel.
 */
export function spacingDecls(): Array<[string, string]> {
  const decls: Array<[string, string]> = SPACE_STEPS.map((n) => [
    `space-${n}`,
    `calc(${space[n].clamp} * var(--glacier-density-scale))`,
  ]);
  decls.push(['space-px', '1px']);
  return decls;
}
