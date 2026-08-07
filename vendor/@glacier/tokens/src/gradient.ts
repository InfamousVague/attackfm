/**
 * Gradient tokens - semantic gradients built from the OKLCH ramps, not
 * one-off hexes. Every stop references an existing custom property, so each
 * gradient retunes automatically with the theme, the theme preset, AND the
 * data-accent picker; nothing here needs a per-theme override block.
 *
 * The one deliberate exception: the scrim ladder is theme-INVARIANT. Scrims
 * exist to protect light text over arbitrary media, and that job is the same
 * dark-ink-to-transparent wash whether the app is in light or dark mode.
 */

import { statuses } from './semantic.ts';

const v = (name: string) => `var(--glacier-${name})`;

/** The tone -> source-ramp map behind the wash family: neutral and accent, plus the status ramps semantic.ts already names. */
export const gradientWashRamps: Record<string, string> = {
  neutral: 'gray',
  accent: 'accent',
  ...Object.fromEntries(Object.entries(statuses).map(([role, { ramp }]) => [role, ramp])),
};

/** A quiet top-light wash for one ramp: step 3 fading to step 1 down the 135deg diagonal. */
const wash = (ramp: string): string =>
  `linear-gradient(135deg in oklch, ${v(`${ramp}-3`)}, ${v(`${ramp}-1`)})`;

/** The scrim ladder: (alpha, stop) pairs from lightest protection to heaviest. */
export const scrimSteps: Array<[alpha: number, stop: string]> = [
  [0.4, '55%'],
  [0.65, '65%'],
  [0.85, '75%'],
];

// ---- CSS emission ----------------------------------------------------------

/** The gradient family. Theme-agnostic: every stop rides an existing token. */
export function gradientDecls(): Array<[string, string]> {
  const decls: Array<[string, string]> = [];

  // The loud accent fill (Button variant="gradient"); text pairs with accent-contrast.
  decls.push(['gradient-accent', `linear-gradient(135deg in oklch, ${v('accent-8')}, ${v('accent-10')})`]);

  // The quiet per-tone washes (Card variant="wash" consumes the accent one).
  for (const [tone, ramp] of Object.entries(gradientWashRamps)) decls.push([`gradient-wash-${tone}`, wash(ramp)]);

  // Surface top-light, theme-aware through glass-highlight.
  decls.push(['gradient-sheen', `linear-gradient(180deg, ${v('glass-highlight')}, transparent 45%)`]);

  // The scrim ladder - deliberately theme-invariant (see the header comment).
  for (const [i, [alpha, stop]] of scrimSteps.entries())
    decls.push([`gradient-scrim-${i + 1}`, `linear-gradient(to top, oklch(0.13 0.01 260 / ${alpha}), transparent ${stop})`]);

  // The hover-sweep paint the shape layer slides in from the leading edge.
  decls.push([
    'gradient-sweep',
    'linear-gradient(100deg, color-mix(in oklch, var(--glacier-accent-solid) 26%, transparent), color-mix(in oklch, var(--glacier-accent-solid) 8%, transparent) 55%, transparent 85%)',
  ]);

  return decls;
}
