/**
 * Fixed size scale for square and circular component footprints - avatar,
 * badge, counter, status-dot, and spinner diameters. Unlike spacing these are
 * intentionally NOT fluid: a control's footprint should stay stable across
 * viewports, so the same step always renders the same size.
 */

export const sizes = {
  '2xs': '0.5rem',
  xs: '0.625rem',
  sm: '1rem',
  md: '1.25rem',
  lg: '1.5rem',
  xl: '1.75rem',
  '2xl': '2.25rem',
  '3xl': '3rem',
  '4xl': '4rem',
} as const;

export type SizeStep = keyof typeof sizes;

// ---- CSS emission ----------------------------------------------------------

/** The size scale as `size-<step>` declarations. */
export function sizeDecls(): Array<[string, string]> {
  return Object.entries(sizes).map(([name, value]) => [`size-${name}`, value]);
}
