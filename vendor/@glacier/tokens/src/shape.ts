/**
 * Shape tokens - the geometry knobs behind the kit's gamified silhouettes
 * (rect / slant / notch / edge, the vocabulary in @glacier/spec).
 *
 * All geometry is theme-agnostic and overridable at :root, the same way
 * --glacier-radius-scale works: retune the slant angle or the notch depth in
 * one place and every shaped surface follows. The shadow pair is the one
 * themed piece: clip-path and transform swallow box-shadow, so shaped
 * surfaces carry their depth on filter: drop-shadow() instead of the
 * elevation ladder, and the drop half needs per-theme ink like shadows do.
 */

import type { Theme } from './color.ts';

export const shapeGeometry = {
  /**
   * The plate corner. A silhouette needs a plate, and a plate cannot be a
   * capsule: skewing or clipping a --glacier-radius-full control turns it into
   * a leaning lozenge with no readable corners, which is why the hand-rolled
   * prior art drew its slanted plates at radius-sm. So the engine gives every
   * shaped host this radius, and a component whose rectangle already has a
   * plate-sized corner (Card, StatTile, NavBar) republishes its own here to
   * keep it.
   */
  'shape-radius': 'var(--glacier-radius-sm)',
  /** The skew of the `slant` parallelogram (PC's OW2-style menu plates). */
  'shape-slant-angle': '8deg',
  /** Corner cut depth for the `notch` plate (top inline-end + bottom inline-start). */
  'shape-notch': '18px',
  /** How far both inline ends angle in on the `edge` banner. */
  'shape-edge-cut': '14px',
  /**
   * Extra inline padding adopted components add under shape="slant", so
   * content clears the plate's skewed inline edges (~tan(angle) x height / 2).
   */
  'shape-slant-pad': '0.375rem',
  /** The accent leading-edge stripe at rest. */
  'shape-accent-edge': '3px',
  /** The stripe's width while hovered or focus-visible. */
  'shape-accent-edge-active': '6px',
} as const;

/**
 * The drop half of the shaped-depth pair, per theme. drop-shadow() has no
 * spread, so this replaces (not augments) the box-shadow elevation ladder on
 * shaped surfaces.
 */
export const shapeShadows: Record<Theme, string> = {
  light: '0 8px 22px oklch(0.2 0.01 260 / 0.25)',
  dark: '0 8px 22px oklch(0 0 0 / 0.45)',
};

/**
 * The glow half: an accent halo that follows the silhouette. Theme-agnostic -
 * it rides var(--glacier-accent-solid), so it retunes with the data-accent
 * picker automatically.
 */
export const SHAPE_GLOW = '0 0 14px color-mix(in oklch, var(--glacier-accent-solid) 30%, transparent)';

// ---- CSS emission ----------------------------------------------------------

/** The theme-agnostic shape geometry knobs. */
export function shapeDecls(): Array<[string, string]> {
  return Object.entries(shapeGeometry);
}

/** The shaped-surface depth pair (drop + glow) for one theme. */
export function shapeShadowDecls(theme: Theme): Array<[string, string]> {
  return [
    ['shape-shadow', shapeShadows[theme]],
    ['shape-glow', SHAPE_GLOW],
  ];
}
