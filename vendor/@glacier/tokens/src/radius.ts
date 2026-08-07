/**
 * Radius ramp. Every step except `none` and `full` is multiplied by the
 * global --glacier-radius-scale knob, so the whole kit's shape language can
 * be sharpened or softened in one place.
 *
 * The ramp is tuned soft: controls sit on the round end (capsule buttons,
 * 10px inputs) in the style of modern iOS and macOS.
 */

export const radii = {
  none: '0px',
  xs: '0.1875rem',
  sm: '0.375rem',
  md: '0.625rem',
  lg: '1rem',
  xl: '1.375rem',
  '2xl': '1.75rem',
  full: '9999px',
} as const;

export type RadiusStep = keyof typeof radii;

export const SCALED_RADII: RadiusStep[] = ['xs', 'sm', 'md', 'lg', 'xl', '2xl'];

/** Default corner treatment for interactive controls (buttons, segments). */
export const CONTROL_RADIUS = 'var(--glacier-radius-full)';

// ---- CSS emission ----------------------------------------------------------

/** The scale knob, the radius ramp (scaled steps ride the knob), and the control radius. */
export function radiusDecls(): Array<[string, string]> {
  const decls: Array<[string, string]> = [['radius-scale', '1']];
  for (const [name, value] of Object.entries(radii)) {
    const scaled = SCALED_RADII.includes(name as RadiusStep);
    decls.push([`radius-${name}`, scaled ? `calc(${value} * var(--glacier-radius-scale))` : value]);
  }
  decls.push(['control-radius', CONTROL_RADIUS]);
  return decls;
}
