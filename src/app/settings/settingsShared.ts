import { accentOptions } from '@glacier/tokens';
import type { ReactNode } from 'react';
import { BRAND_ACCENTS } from './brandAccents.ts';
import type { ThemePreference } from './themePresets.ts';

/**
 * What the search field matches beyond the visible words: each pane's own
 * vocabulary, written by hand because nothing else knows that "crossfade"
 * lives in Playback or "invite" under Servers. Lowercase, space-separated;
 * label and summary are always matched too.
 */
export const PANE_KEYWORDS: Record<string, string> = {
  appearance: 'theme dark light accent color colour scale text size dawn boreal ember midnight alpine',
  general: 'haptics vibration folder music directory metadata artwork lyrics online',
  playback: 'crossfade gapless sleep timer equalizer eq bands pause style shuffle repeat quality volume',
  server: 'server connect sign in url mirror network invite join host latency devices speakers where you listen seat',
  storage: 'cache offline downloads space disk limit pins clear',
  notifications: 'push alerts recap weekly interrupt',
  plugins: 'plugin extension import spotify buy discover sources',
  about: 'version update check whats new shell licenses github',
};

export function paneMatches(section: SettingsSection, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    section.label,
    typeof section.summary === 'string' ? section.summary : '',
    PANE_KEYWORDS[section.id] ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** Same coarse/narrow signal the player folds its rails on, so Settings turns
 *  into the touch drill-in exactly where the rest of the mobile chrome does. */
// Coarse pointer alone is not "phone": an unfolded foldable is all thumb and
// 840px wide, and the full-screen drill-in wastes that room. The phone
// treatment now requires the screen to actually be narrow; a wide touch
// screen gets the desktop modal, rail and all.
export const MOBILE_QUERY = '(pointer: coarse) and (max-width: 699px), (max-width: 540px)';

/** One entry in the settings rail: an id, its label, its icon, its pane -
 * plus what the phone's drill-in list needs: a one-line reading of the
 * section's current state, a tint for its icon chip, and which cluster of
 * rows it files under. */
export interface SettingsSection {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
  /** The row's second line on the touch list, e.g. "Midnight · Attack". */
  summary?: string;
  /** The icon chip's colour family on the touch list. */
  tint?: 'pink' | 'blue' | 'green' | 'orange' | 'purple' | 'slate';
  /** Rows with the same group cluster into one card on the touch list. */
  group?: number;
}

// The name and one-line gloss for each theme, keyed by preset id.
export const THEME_COPY: Record<ThemePreference, { label: string; description: string }> = {
  system: { label: 'Automatic', description: 'Follows the system.' },
  light: { label: 'Alpine', description: 'Bright and neutral.' },
  dark: { label: 'Midnight', description: 'Dim and neutral.' },
  dawn: { label: 'Dawn', description: 'Warm light.' },
  boreal: { label: 'Boreal', description: 'Cool dark.' },
  ember: { label: 'Ember', description: 'Warm dark.' },
};

/** The accent slug's human name, brand accents first, kit accents after. */
export function accentLabel(accent: string): string {
  const brand = Object.values(BRAND_ACCENTS).find((a) => a.name === accent);
  if (brand) return brand.label;
  return accentOptions.find((a) => a.name === accent)?.label ?? accent;
}
