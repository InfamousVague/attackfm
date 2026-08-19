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
  handbook:
    'handbook guide manual documentation docs how it works help plugin develop developer api build publish gestures',
};

/**
 * Every individual setting, so the search box can find one.
 *
 * The field says "Find a setting" and until now found only PANES: typing
 * "stems" or "crossfade" matched whatever pane happened to list that word in
 * PANE_KEYWORDS, and answered with a rail entry rather than the row. Anything
 * not thought of when the keyword string was written was simply unfindable -
 * which is how a settings screen quietly becomes a place people give up on.
 *
 * Each row registers itself here with the words somebody would actually type,
 * including the ones the row does not say out loud: "wifi" for a download
 * switch, "phone home" for a telemetry one.
 */
export interface SettingEntry {
  /** Stable id, also the row's anchor for scroll-to. */
  id: string;
  /** Which pane holds it - a SettingsSection.id. */
  pane: string;
  label: string;
  description: string;
  /** What someone would type looking for it, beyond the words above. */
  keywords?: string;
}

export const SETTINGS_INDEX: SettingEntry[] = [
  {
    id: 'online-metadata',
    pane: 'privacy',
    label: 'Online metadata lookups',
    description: 'Lyrics from LRCLIB and album art from Apple, keyed by track titles.',
    keywords: 'lyrics artwork album art lrclib apple itunes third party internet offline',
  },
  {
    id: 'listening-history',
    pane: 'privacy',
    label: 'Save listening history',
    description: 'Reports finished listens to your server, which feeds recently-played and your mixes.',
    keywords: 'history scrobble plays recently played mixes recap stats tracking',
  },
  {
    id: 'share-position',
    pane: 'privacy',
    label: 'Keep my place across devices',
    description: 'Sends what you are playing and how far in to your AttackFM account.',
    keywords: 'resume position where i left off sync registry account telemetry phone home now playing',
  },
  {
    id: 'share-week',
    pane: 'privacy',
    label: 'Share my week with friends',
    description: 'Minutes listened, your top artist and your streak, visible to friends you accept.',
    keywords: 'friends social share week streak top artist stats registry',
  },
  {
    id: 'now-playing-video',
    pane: 'playback',
    label: 'Video clips on Now Playing',
    description: "The song's short looping clip behind the full player.",
    keywords: 'canvas video clip loop spotify animation background data cellular battery',
  },
  {
    id: 'auto-upload',
    pane: 'server',
    label: 'Send new music to this server',
    description: 'Uploads anything in your music folder this server does not have.',
    keywords: 'upload sync folder send push library bandwidth friend someone else server',
  },
  {
    id: 'stem-prefetch',
    pane: 'server',
    label: 'Separate songs before you ask',
    description: 'Pulls liked and playlisted songs apart in the background so the Pads open instantly.',
    keywords: 'stems separate demucs pads sampler karaoke vocals drums bass prefetch ahead gpu disk background auto stemming',
  },
];

/** Does one row answer this query? Same AND-across-words rule as the panes. */
export function settingMatches(entry: SettingEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [entry.label, entry.description, entry.keywords ?? ''].join(' ').toLowerCase();
  return q.split(/\s+/).every((word) => hay.includes(word));
}

/** The rows a query finds, in index order. */
export function settingsMatching(query: string): SettingEntry[] {
  const q = query.trim();
  if (!q) return [];
  return SETTINGS_INDEX.filter((e) => settingMatches(e, q));
}

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
