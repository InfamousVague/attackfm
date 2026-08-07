/**
 * OKLCH color ramps.
 *
 * Every color is a 12-step ramp generated in OKLCH so apparent lightness is
 * consistent across hues. Step numbering follows fixed roles, which is what
 * lets the semantic layer stay identical across light and dark themes:
 *
 *   1–2   app / subtle backgrounds
 *   3–5   component backgrounds (rest / hover / active)
 *   6–8   borders (subtle / default / strong+focus)
 *   9–10  solid fills (rest / hover)
 *   11–12 text (low contrast / high contrast)
 */

export type Theme = 'light' | 'dark';

export interface RampDef {
  name: string;
  hue: number;
  /** peak chroma, reached at the solid steps (9–10) */
  chroma: number;
  /** text color that sits on top of the step-9 solid */
  contrast: 'white' | 'black';
}

export const ramps: RampDef[] = [
  { name: 'gray', hue: 260, chroma: 0.012, contrast: 'white' },
  { name: 'accent', hue: 228, chroma: 0.15, contrast: 'white' },
  { name: 'red', hue: 25, chroma: 0.19, contrast: 'white' },
  { name: 'amber', hue: 75, chroma: 0.15, contrast: 'black' },
  { name: 'green', hue: 150, chroma: 0.14, contrast: 'white' },
  { name: 'blue', hue: 228, chroma: 0.15, contrast: 'white' },
  { name: 'purple', hue: 305, chroma: 0.17, contrast: 'white' },
  { name: 'teal', hue: 190, chroma: 0.12, contrast: 'black' },
];

/**
 * Pickable accent options. The first entry is the built-in default; the
 * generator emits a [data-accent='name'] override block (light and dark) for
 * each of the others, so apps switch accent by setting the attribute on
 * <html>. Everything derived from the accent ramp (soft backgrounds, focus
 * ring, selection) follows automatically.
 */
export interface AccentOption {
  name: string;
  label: string;
  hue: number;
  chroma: number;
  /** Text color that sits on the accent-9 solid, from the source ramp. */
  contrast: 'white' | 'black';
}

// Each pickable accent borrows its hue and chroma from a kit ramp, so the picker
// can never drift from the palette the kit actually ships. The default 'blue'
// mirrors the base accent ramp, so choosing it is a no-op override.
const ACCENT_SOURCES: Array<{ name: string; label: string; ramp: string }> = [
  { name: 'blue', label: 'Blue', ramp: 'accent' },
  { name: 'green', label: 'Green', ramp: 'green' },
  { name: 'purple', label: 'Purple', ramp: 'purple' },
  { name: 'teal', label: 'Teal', ramp: 'teal' },
  { name: 'amber', label: 'Amber', ramp: 'amber' },
  { name: 'red', label: 'Red', ramp: 'red' },
  { name: 'graphite', label: 'Graphite', ramp: 'gray' },
];

export const accentOptions: AccentOption[] = ACCENT_SOURCES.map(({ name, label, ramp }) => {
  const def = ramps.find((r) => r.name === ramp);
  if (!def) throw new Error(`accent option "${name}" references unknown ramp "${ramp}"`);
  return { name, label, hue: def.hue, chroma: def.chroma, contrast: def.contrast };
});

/** The 12 accent steps for an option in the given theme. */
export function accentSteps(option: AccentOption, theme: Theme): string[] {
  return rampSteps({ name: 'accent', hue: option.hue, chroma: option.chroma, contrast: option.contrast }, theme);
}

// Lightness curve per step. Light runs bright→dark, dark runs dark→bright, so
// the same step number plays the same role in both themes. Dark runs deep:
// near-black backgrounds with brighter solids and text for contrast.
const LIGHTNESS: Record<Theme, number[]> = {
  light: [0.993, 0.981, 0.96, 0.936, 0.906, 0.87, 0.822, 0.755, 0.627, 0.578, 0.498, 0.303],
  dark: [0.14, 0.17, 0.21, 0.248, 0.285, 0.33, 0.39, 0.485, 0.64, 0.7, 0.805, 0.935],
};

// Chroma envelope: quiet at the background steps, peaking at the solids.
// Dark pushes past 1 at the solids so color pops against the deep grounds.
const CHROMA_MULT: Record<Theme, number[]> = {
  light: [0.06, 0.12, 0.25, 0.4, 0.55, 0.7, 0.85, 1, 1, 1, 0.85, 0.55],
  dark: [0.14, 0.2, 0.32, 0.45, 0.58, 0.7, 0.85, 1, 1.08, 1.08, 0.85, 0.42],
};

export const RAMP_SIZE = 12;

const round = (n: number, places: number): number => {
  const f = 10 ** places;
  return Math.round(n * f) / f;
};

/** Returns the 12 oklch() strings for a ramp in the given theme. */
export function rampSteps(def: RampDef, theme: Theme): string[] {
  const light = LIGHTNESS[theme];
  const mult = CHROMA_MULT[theme];
  return light.map((l, i) => {
    const c = round(def.chroma * (mult[i] ?? 1), 4);
    return `oklch(${round(l, 3)} ${c} ${def.hue})`;
  });
}

export const WHITE = 'oklch(0.995 0 0)';
export const BLACK_TEXT = 'oklch(0.22 0.015 260)';

// ---- CSS emission ----------------------------------------------------------

/** Every ramp's 12 steps as `<ramp>-<n>` declarations for one theme. */
export function rampDecls(theme: Theme): Array<[string, string]> {
  return ramps.flatMap((ramp) =>
    rampSteps(ramp, theme).map((color, i) => [`${ramp.name}-${i + 1}`, color] as [string, string]),
  );
}

/** The 12 `accent-<n>` declarations for one pickable accent option. */
export function accentDecls(option: AccentOption, theme: Theme): Array<[string, string]> {
  const steps = accentSteps(option, theme).map((color, i) => [`accent-${i + 1}`, color] as [string, string]);
  // carry the ramp's on-solid text color too, so light accents (amber, teal)
  // flip accent-contrast to dark text instead of the base white.
  const contrast = option.contrast === 'black' ? BLACK_TEXT : WHITE;
  return [...steps, ['accent-contrast', contrast]];
}
