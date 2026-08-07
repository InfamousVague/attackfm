/**
 * Modular type scale.
 *
 * Sizes are generated from a ratio off a 1rem base, and are fluid like the
 * space scale: minor third (1.2) at the 320px viewport growing to major third
 * (1.25) off a 1.125rem base at 1536px, so headings gain more room on large
 * screens than body text does.
 */

import { fluid, type FluidValue } from './space.ts';

export const TYPE_BASE_MIN = 1; // rem at 320px
export const TYPE_BASE_MAX = 1.125; // rem at 1536px
export const TYPE_RATIO_MIN = 1.2;
export const TYPE_RATIO_MAX = 1.25;

export interface TypeStep {
  name: string;
  /** position on the modular scale relative to the base (md = 0) */
  step: number;
  size: FluidValue;
  lineHeight: number;
  tracking: string;
}

const NAMES = ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'] as const;
const FIRST_STEP = -2;

const lineHeightFor = (step: number): number =>
  step <= 0 ? 1.5 : step <= 2 ? 1.4 : step <= 4 ? 1.2 : 1.1;

const trackingFor = (step: number): string =>
  step >= 4 ? '-0.02em' : step >= 2 ? '-0.01em' : '0em';

export const typeScale: TypeStep[] = NAMES.map((name, i) => {
  const step = FIRST_STEP + i;
  return {
    name,
    step,
    size: fluid(TYPE_BASE_MIN * TYPE_RATIO_MIN ** step, TYPE_BASE_MAX * TYPE_RATIO_MAX ** step),
    lineHeight: lineHeightFor(step),
    tracking: trackingFor(step),
  };
});

// System fallbacks appended to every bundled family, so text still renders
// before the webfont loads and for scripts a family does not cover.
const SYSTEM_SANS = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const SYSTEM_MONO = "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, monospace";

/**
 * Switchable sans families, bundled via Fontsource (see css/fonts.css). The
 * first key is the default and matches the base --glacier-font-sans, so its
 * [data-font] selector would be a no-op and is not emitted.
 */
export const sansFonts = {
  inter: `'Inter Variable', ${SYSTEM_SANS}`,
  noto: `'Noto Sans Variable', ${SYSTEM_SANS}`,
  plex: `'IBM Plex Sans', ${SYSTEM_SANS}`,
} as const;

/** Switchable mono families; the first key is the default mono. */
export const monoFonts = {
  jetbrains: `'JetBrains Mono Variable', ${SYSTEM_MONO}`,
  plex: `'IBM Plex Mono', ${SYSTEM_MONO}`,
} as const;

export type SansFont = keyof typeof sansFonts;
export type MonoFont = keyof typeof monoFonts;

export const fontFamilies = {
  sans: sansFonts.inter,
  mono: monoFonts.jetbrains,
} as const;

export const fontWeights = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

// ---- CSS emission ----------------------------------------------------------

/** Font families, weights, and the fluid size / leading / tracking per step. */
export function typographyDecls(): Array<[string, string]> {
  const decls: Array<[string, string]> = [
    ['font-sans', fontFamilies.sans],
    ['font-mono', fontFamilies.mono],
  ];
  for (const [name, weight] of Object.entries(fontWeights)) decls.push([`font-weight-${name}`, String(weight)]);
  for (const step of typeScale) {
    decls.push(
      [`font-size-${step.name}`, step.size.clamp],
      [`leading-${step.name}`, String(step.lineHeight)],
      [`tracking-${step.name}`, step.tracking],
    );
  }
  return decls;
}

/** Override just the sans family, for a [data-font='name'] block. */
export function sansFontDecls(name: SansFont): Array<[string, string]> {
  return [['font-sans', sansFonts[name]]];
}

/** Override just the mono family, for a [data-mono='name'] block. */
export function monoFontDecls(name: MonoFont): Array<[string, string]> {
  return [['font-mono', monoFonts[name]]];
}
