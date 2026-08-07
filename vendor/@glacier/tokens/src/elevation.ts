/**
 * Elevation: layered shadows tuned per theme. Dark surfaces need stronger
 * shadows plus their lighter background steps to read as raised.
 */

import type { Theme } from './color.ts';

const ink = (alpha: number) => `oklch(0.2 0.02 260 / ${alpha})`;

export const shadows: Record<Theme, string[]> = {
  light: [
    'none',
    `0 1px 2px -1px ${ink(0.08)}, 0 1px 3px ${ink(0.06)}`,
    `0 2px 4px -2px ${ink(0.1)}, 0 4px 8px -2px ${ink(0.06)}`,
    `0 4px 8px -4px ${ink(0.12)}, 0 8px 16px -4px ${ink(0.08)}`,
    `0 8px 16px -8px ${ink(0.14)}, 0 16px 32px -8px ${ink(0.1)}`,
    `0 16px 32px -12px ${ink(0.18)}, 0 32px 64px -12px ${ink(0.12)}`,
  ],
  dark: [
    'none',
    `0 1px 2px -1px ${ink(0.4)}, 0 1px 3px ${ink(0.3)}`,
    `0 2px 4px -2px ${ink(0.45)}, 0 4px 8px -2px ${ink(0.3)}`,
    `0 4px 8px -4px ${ink(0.5)}, 0 8px 16px -4px ${ink(0.35)}`,
    `0 8px 16px -8px ${ink(0.55)}, 0 16px 32px -8px ${ink(0.4)}`,
    `0 16px 32px -12px ${ink(0.6)}, 0 32px 64px -12px ${ink(0.45)}`,
  ],
};

// Dark pages swallow shadows: ink on a near-black background barely reads, so
// raised dark surfaces ALSO lighten with elevation, the way a light theme's
// shadows deepen. Light keeps the overlays fully transparent - shadows carry
// the depth there - so components can paint the overlay unconditionally.
const lift = (alpha: number) => `oklch(1 0 0 / ${alpha})`;

export const elevationOverlays: Record<Theme, string[]> = {
  light: Array.from({ length: 6 }, () => lift(0)),
  dark: [lift(0), lift(0.04), lift(0.06), lift(0.09), lift(0.12), lift(0.15)],
};

// ---- CSS emission ----------------------------------------------------------

/** The six `shadow-<n>` levels for one theme. */
export function shadowDecls(theme: Theme): Array<[string, string]> {
  return shadows[theme].map((s, i) => [`shadow-${i}`, s] as [string, string]);
}

/** The six `elevation-overlay-<n>` surface tints for one theme. */
export function elevationOverlayDecls(theme: Theme): Array<[string, string]> {
  return elevationOverlays[theme].map((o, i) => [`elevation-overlay-${i}`, o] as [string, string]);
}
