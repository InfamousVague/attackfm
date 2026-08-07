import type { AccentOption } from '@glacier/tokens';

/**
 * AttackFM's own accents, which the kit does not ship a `[data-accent]` rule
 * for. Each is the OKLCH of a brand hex, fed through the kit's ramp so it gets
 * the same twelve steps every built-in accent has. 'attack' is #FC427B.
 *
 * `deep` pulls the saturated end of the ramp (the solids and text) darker than
 * the kit's normalised curve, so a deep-red brand reads deep rather than being
 * flattened to the same mid-tone every accent sits at.
 */
export const BRAND_ACCENTS: Record<string, AccentOption & { swatch: string; deep?: number }> = {
  attack: { name: 'attack', label: 'Attack', hue: 8, chroma: 0.22, contrast: 'white', swatch: '#FC427B' },
  sand: { name: 'sand', label: 'Sand', hue: 87, chroma: 0.02, contrast: 'black', swatch: '#f7f1e3' },
};
