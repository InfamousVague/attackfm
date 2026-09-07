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

/**
 * The kit's AccentOption with its `label` swapped for a catalogue key.
 *
 * The swap is the point: this table is built when the module is imported,
 * which is before anybody has chosen a language, so a name written here is the
 * name the picker keeps for the rest of the session however many times the
 * language changes. `accentLabel` (settingsShared) resolves the key instead,
 * at render, where the answer can still change.
 *
 * Nothing is lost by dropping `label` - the ramp maths reads hue, chroma and
 * contrast and never the name.
 */
export interface BrandAccent extends Omit<AccentOption, 'label'> {
  /** Catalogue key for the swatch's name. */
  labelKey: string;
  /** The dot the picker paints: the brand hex itself, not a ramp step. */
  swatch: string;
  deep?: number;
}

export const BRAND_ACCENTS: Record<string, BrandAccent> = {
  attack: { name: 'attack', labelKey: 'settings.accentAttack', hue: 8, chroma: 0.22, contrast: 'white', swatch: '#FC427B' },
  sand: { name: 'sand', labelKey: 'settings.accentSand', hue: 87, chroma: 0.02, contrast: 'black', swatch: '#f7f1e3' },
};
