/**
 * Layout tokens: container max-widths and the responsive breakpoints the
 * layout primitives switch on. Breakpoints are emitted as informational
 * tokens; the layout CSS hardcodes the same pixel values in its @media
 * queries (CSS media queries cannot read custom properties), so this file is
 * the single source of truth for both.
 */

export const containers = {
  xs: '20rem',
  sm: '30rem',
  md: '42rem',
  lg: '60rem',
  xl: '75rem',
  prose: '68ch',
  full: '100%',
} as const;

export type ContainerSize = keyof typeof containers;

export const breakpoints = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export type Breakpoint = keyof typeof breakpoints;

// ---- CSS emission ----------------------------------------------------------

/** Container max-widths and the informational breakpoint tokens. */
export function layoutDecls(): Array<[string, string]> {
  const decls: Array<[string, string]> = Object.entries(containers).map(
    ([name, value]) => [`container-${name}`, value],
  );
  for (const [name, px] of Object.entries(breakpoints)) decls.push([`breakpoint-${name}`, `${px}px`]);
  return decls;
}
