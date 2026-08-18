import { useCallback, useEffect, useState } from 'react';
import { accentSteps, type Theme } from '@glacier/tokens';
// The product's own brand accent, not a copy of it. #FC427B lives in exactly one
// file in this repo; the site reads that file so the page can never drift from
// the app it is selling.
import { BRAND_ACCENTS } from '../../src/app/settings/brandAccents.ts';

const STORAGE_KEY = 'attackfm-site-theme';
const ATTACK = BRAND_ACCENTS.attack!;

/** The brand hex itself, for the few places that need a literal (SVG, canvas). */
export const BRAND_HEX = ATTACK.swatch;

/**
 * Paint the twelve accent steps onto the document.
 *
 * The kit ships `[data-accent]` rules for its own six accents, but not for a
 * brand one - the app generates the ramp at runtime and so does this. Both call
 * the same `accentSteps`, so the pink on the page is the pink in the product,
 * derived rather than eyeballed.
 */
function applyAccent(scheme: Theme): void {
  const root = document.documentElement;
  accentSteps(ATTACK, scheme).forEach((value, index) =>
    root.style.setProperty(`--glacier-accent-${index + 1}`, value),
  );
  root.style.setProperty(
    '--glacier-accent-contrast',
    ATTACK.contrast === 'white' ? 'oklch(0.995 0 0)' : 'oklch(0.18 0 0)',
  );
}

function currentTheme(): Theme {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/**
 * The theme toggle.
 *
 * The initial value is resolved by the inline script in index.html, before
 * paint; this hook adopts whatever that decided rather than deciding again,
 * which is what keeps the first frame from flashing the wrong ground.
 */
export function useTheme(): { theme: Theme; toggle: () => void } {
  const [theme, setTheme] = useState<Theme>(() =>
    typeof document === 'undefined' ? 'dark' : currentTheme(),
  );

  // The accent ramp differs per scheme, so it is repainted on every change.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    applyAccent(theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // Private mode - the choice simply does not outlive the visit.
      }
      return next;
    });
  }, []);

  return { theme, toggle };
}
