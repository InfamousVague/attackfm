/**
 * Motion tokens, named by role so the whole kit's feel retunes in one place.
 * The @glacier/motion package mirrors these as framer-motion transitions.
 */

export const durations = {
  instant: 75,
  fast: 150,
  normal: 250,
  slow: 400,
  slower: 600,
} as const;

export type DurationRole = keyof typeof durations;

export const easings = {
  out: [0.16, 1, 0.3, 1],
  'in-out': [0.65, 0, 0.35, 1],
  spring: [0.34, 1.56, 0.64, 1],
  exit: [0.4, 0, 1, 1],
} as const;

export type EaseRole = keyof typeof easings;

export const cssEase = (name: EaseRole): string =>
  `cubic-bezier(${easings[name].join(', ')})`;

/**
 * The per-item delay behind staggered entrances (the rise-in family): item i
 * waits i x this step. Consumers set --glacier-stagger-i as data; the step
 * size lives here so the whole kit's stagger retunes in one place.
 * @glacier/motion mirrors this as STAGGER_STEP_MS.
 */
export const STAGGER_STEP_MS = 60;

// ---- CSS emission ----------------------------------------------------------

/** Durations, easing curves, and the stagger step, named by role. */
export function motionDecls(): Array<[string, string]> {
  const decls: Array<[string, string]> = [];
  for (const [name, ms] of Object.entries(durations)) decls.push([`duration-${name}`, `${ms}ms`]);
  for (const name of Object.keys(easings)) decls.push([`ease-${name}`, cssEase(name as EaseRole)]);
  decls.push(['stagger-step', `${STAGGER_STEP_MS}ms`]);
  return decls;
}

/**
 * Under prefers-reduced-motion, collapse every duration - and the stagger
 * step, so staggered entrances land together - to near-zero.
 */
export function reducedMotionDecls(): Array<[string, string]> {
  return [
    ...Object.keys(durations).map((name) => [`duration-${name}`, '0.01ms'] as [string, string]),
    ['stagger-step', '0.01ms'] as [string, string],
  ];
}
