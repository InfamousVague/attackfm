/**
 * WCAG 2.1 contrast engine for the kit's OKLCH palette.
 *
 * Pure math end to end: oklch() strings are parsed, converted through OKLab
 * and LMS into linear sRGB (clamped to the displayable gamut), reduced to
 * relative luminance, and compared with the WCAG 2.1 contrast-ratio formula.
 * No browser or CSS engine is involved, so the audit runs in plain node
 * against the same TS sources the generator emits tokens.css from.
 */

import { ramps, rampSteps, type Theme } from './color.ts';
import { semantic, themeOverrides, statuses, statusTokens } from './semantic.ts';

// ---- color parsing ---------------------------------------------------------

export interface Oklch {
  l: number;
  c: number;
  h: number;
  alpha: number;
}

const OKLCH_RE =
  /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)(?:deg)?\s*(?:\/\s*([\d.]+%?)\s*)?\)$/i;

const num = (raw: string): number =>
  raw.endsWith('%') ? Number(raw.slice(0, -1)) / 100 : Number(raw);

/** Parses an `oklch(L C H)` / `oklch(L C H / A)` string as the kit emits them. */
export function parseOklch(input: string): Oklch {
  const match = OKLCH_RE.exec(input.trim());
  if (!match) throw new Error(`not a parseable oklch() color: "${input}"`);
  return {
    l: num(match[1]!),
    c: num(match[2]!),
    h: num(match[3]!),
    alpha: match[4] === undefined ? 1 : num(match[4]!),
  };
}

// ---- OKLCH -> linear sRGB --------------------------------------------------

export interface LinearRgb {
  r: number;
  g: number;
  b: number;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/**
 * OKLCH -> OKLab -> LMS -> linear sRGB, using Bjorn Ottosson's reference
 * matrices. Out-of-gamut channels are clamped to [0, 1], which matches how
 * browsers rasterize the kit's slightly-out-of-gamut dark solid steps.
 */
export function oklchToLinearSrgb(color: Oklch): LinearRgb {
  const hRad = (color.h * Math.PI) / 180;
  const a = color.c * Math.cos(hRad);
  const b = color.c * Math.sin(hRad);

  const l_ = color.l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = color.l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = color.l - 0.0894841775 * a - 1.291485548 * b;

  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  return {
    r: clamp01(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clamp01(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clamp01(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

// ---- relative luminance and contrast ratio ---------------------------------

/** WCAG 2.1 inverse-companding for one 0..1 gamma-encoded sRGB channel. */
const srgbToLinear = (channel: number): number =>
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;

const parseHex = (input: string): LinearRgb => {
  const hex = input.slice(1);
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : hex;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`not a parseable hex color: "${input}"`);
  const channel = (offset: number) => srgbToLinear(parseInt(full.slice(offset, offset + 2), 16) / 255);
  return { r: channel(0), g: channel(2), b: channel(4) };
};

/** Accepts an oklch() string (the kit's native format) or a #rrggbb/#rgb hex. */
const toLinearSrgb = (color: string): LinearRgb =>
  color.startsWith('#') ? parseHex(color) : oklchToLinearSrgb(parseOklch(color));

/** WCAG 2.1 relative luminance (Y) of a color, 0 = black, 1 = white. */
export function relativeLuminance(color: string): number {
  const { r, g, b } = toLinearSrgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.1 contrast ratio between two colors, 1..21. Order-independent. */
export function contrastRatio(fg: string, bg: string): number {
  const y1 = relativeLuminance(fg);
  const y2 = relativeLuminance(bg);
  const lighter = Math.max(y1, y2);
  const darker = Math.min(y1, y2);
  return (lighter + 0.05) / (darker + 0.05);
}

// ---- token resolution ------------------------------------------------------

const VAR_RE = /^var\(--glacier-([a-z]+)-(\d+)\)$/;

/** Resolves a `var(--glacier-<ramp>-<step>)` reference to its oklch() value. */
function resolveRampVar(reference: string, theme: Theme): string {
  const match = VAR_RE.exec(reference);
  if (!match) throw new Error(`not a ramp var() reference: "${reference}"`);
  const def = ramps.find((r) => r.name === match[1]);
  if (!def) throw new Error(`unknown ramp "${match[1]}" in "${reference}"`);
  const step = Number(match[2]);
  const steps = rampSteps(def, theme);
  const value = steps[step - 1];
  if (!value) throw new Error(`ramp step out of range in "${reference}"`);
  return value;
}

/**
 * Resolves a semantic or status token name to its concrete oklch() value for
 * one theme, straight from the TS sources (semantic aliases, per-theme
 * overrides, status aliases, ramp steps) rather than the generated CSS.
 */
export function resolveTokenColor(token: string, theme: Theme): string {
  const raw = themeOverrides[theme][token] ?? semantic[token] ?? statusTokens()[token];
  if (raw === undefined) throw new Error(`unknown color token "${token}"`);
  return raw.startsWith('var(') ? resolveRampVar(raw, theme) : raw;
}

// ---- kit audit --------------------------------------------------------------

/**
 * Required WCAG 2.1 ratios per pairing, chosen by how the kit actually uses
 * each pair:
 *
 * - REQUIRED_TEXT (4.5): body-size text. Covers text / text-muted /
 *   text-subtle on surfaces (SC 1.4.3 normal text) and the tone -text colors
 *   on -soft backgrounds, which render normal-size copy in callouts, badges,
 *   and inline validation messages.
 * - REQUIRED_GLYPH (3): the -contrast colors on step-9 solids. Solids carry
 *   large or bold button labels and UI glyphs (the checkbox check, switch
 *   icons, badge dots), so the SC 1.4.3 large-text / SC 1.4.11 non-text
 *   minimum of 3:1 applies. Rows still report the exact ratio, so pairs that
 *   also clear 4.5 for normal-size text are visible in the data.
 */
export const REQUIRED_TEXT = 4.5;
export const REQUIRED_GLYPH = 3;

export interface ContrastAuditRow {
  /** e.g. "danger-contrast on danger-solid" */
  pair: string;
  theme: Theme;
  foreground: string;
  background: string;
  ratio: number;
  required: number;
  passes: boolean;
}

const TEXT_TOKENS = ['text', 'text-muted', 'text-subtle'] as const;
const SURFACE_TOKENS = ['bg', 'surface', 'surface-raised', 'surface-sunken'] as const;

function row(fgToken: string, bgToken: string, required: number, theme: Theme): ContrastAuditRow {
  const foreground = resolveTokenColor(fgToken, theme);
  const background = resolveTokenColor(bgToken, theme);
  const ratio = Math.round(contrastRatio(foreground, background) * 100) / 100;
  return {
    pair: `${fgToken} on ${bgToken}`,
    theme,
    foreground,
    background,
    ratio,
    required,
    passes: ratio >= required,
  };
}

/**
 * Evaluates the kit's real token pairings in both themes:
 *
 * 1. each status tone's -contrast text on its step-9 -solid (plus accent)
 * 2. text / text-muted / text-subtle on bg, surface, surface-raised,
 *    surface-sunken
 * 3. each status tone's -text on its -soft background
 * 4. accent-text on accent-soft
 */
export function contrastAudit(): ContrastAuditRow[] {
  const rows: ContrastAuditRow[] = [];
  const statusRoles = Object.keys(statuses);

  for (const theme of ['light', 'dark'] as Theme[]) {
    for (const role of statusRoles) {
      rows.push(row(`${role}-contrast`, `${role}-solid`, REQUIRED_GLYPH, theme));
    }
    rows.push(row('accent-contrast', 'accent-solid', REQUIRED_GLYPH, theme));

    for (const text of TEXT_TOKENS) {
      for (const surfaceToken of SURFACE_TOKENS) {
        rows.push(row(text, surfaceToken, REQUIRED_TEXT, theme));
      }
    }

    for (const role of statusRoles) {
      rows.push(row(`${role}-text`, `${role}-soft`, REQUIRED_TEXT, theme));
    }
    rows.push(row('accent-text', 'accent-soft', REQUIRED_TEXT, theme));
  }

  return rows;
}
