/**
 * Density modes, switched by data-density on any ancestor (usually <html>).
 *
 * Two things move together: control heights, and a density scale that
 * multiplies the whole space scale. So every padding and gap built on
 * --glacier-space-* breathes with density while staying on one shared scale.
 *
 * Comfortable remains the default for backwards compatibility. The other
 * modes provide two tighter and two roomier stops around that baseline.
 */

export type Density = 'extra-compact' | 'compact' | 'comfortable' | 'spacious' | 'more-space';

export const controlHeights: Record<Density, Record<'sm' | 'md' | 'lg', string>> = {
  'extra-compact': { sm: '1.625rem', md: '2rem', lg: '2.5rem' },
  comfortable: { sm: '2.25rem', md: '2.75rem', lg: '3.25rem' },
  compact: { sm: '1.875rem', md: '2.25rem', lg: '2.75rem' },
  spacious: { sm: '2.375rem', md: '2.875rem', lg: '3.375rem' },
  'more-space': { sm: '2.5rem', md: '3rem', lg: '3.5rem' },
};

/**
 * Multiplier applied to every space token. Comfortable opens padding and gaps
 * up past the base grid; compact tightens them. The base scale (1.0) sits
 * between the two, so neither mode feels like the middle.
 */
export const densityScale: Record<Density, number> = {
  'extra-compact': 0.65,
  comfortable: 1.1,
  compact: 0.8,
  spacious: 1.2,
  'more-space': 1.35,
};

// ---- CSS emission ----------------------------------------------------------

/** Control heights and the space multiplier for one density mode. */
export function densityDecls(mode: Density): Array<[string, string]> {
  const decls: Array<[string, string]> = Object.entries(controlHeights[mode]).map(
    ([size, h]) => [`control-height-${size}`, h],
  );
  decls.push(['density-scale', String(densityScale[mode])]);
  return decls;
}
