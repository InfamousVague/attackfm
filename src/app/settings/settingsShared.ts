import { accentOptions } from '@glacier/tokens';
import { useEffect, useState, type ReactNode } from 'react';
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
  // The equalizer left for the sound console long ago, and gapless/repeat
  // never had rows here - phantom words that matched this pane made the
  // search LOOK broken ("eq" landed you somewhere with no EQ in it).
  playback: 'crossfade sleep timer pause style shuffle quality volume night mode mono auto dj',
  server: 'server connect sign in url mirror network invite join host latency devices speakers where you listen seat',
  storage: 'cache offline downloads space disk limit pins clear wifi wi-fi mobile data cellular',
  notifications: 'push alerts recap weekly interrupt bell notifications news downloads finished',
  plugins: 'plugin extension import spotify buy discover sources',
  privacy: 'privacy history scrobble tracking metadata lookups lyrics share position telemetry friends',
  diagnostics: 'diagnostics problems errors log report broken crash push notifications debug',
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
  {
    id: 'wifi-only',
    pane: 'storage',
    label: 'Only download on Wi-Fi',
    description: 'Automatic downloads wait for Wi-Fi; playing, pins and Check now are unaffected.',
    // "roaming", "allowance" and "bill" are here because they are what somebody
    // types when they have just been charged for something, which is the moment
    // most people go looking for this row.
    keywords:
      'wifi wi-fi cellular mobile data 4g 5g lte metered roaming allowance bill cap data saver background download',
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

/**
 * Below this many pixels of ACTUAL room, settings shows one thing at a time.
 *
 * Matched to MOBILE_QUERY's 699 on purpose: the phone and a squeezed window are
 * the same problem - not enough width for a rail beside a pane - and answering
 * them at two different numbers would mean two layouts to keep honest.
 */
const TWO_COLUMN_FLOOR = 700;

/**
 * How much width the settings modal actually has, which is NOT the viewport.
 *
 * The kit collapses its own rail at `@media (max-width: 40rem)`, and every
 * media query asks the window. That is the wrong question here: when Now
 * Playing docks, `.appWindow` shrinks to `calc(100% - var(--np-dock-width))`
 * and the modal is centred in what is left - so on a tablet the window stays
 * comfortably past every breakpoint while the modal itself is squeezed to
 * around half of it. The rail and the pane both got drawn, into a box with room
 * for neither: a search field reading "Find a settir", theme cards cut off at
 * the seam.
 *
 * So measure the box rather than the screen. Falls back to the viewport when
 * there is no app window to measure - which is what the value should be then
 * anyway, since the modal has the whole screen.
 */
export interface SettingsRoom {
  /** Pixels of width the modal would actually get. */
  room: number;
}

export function useSettingsRoom(open: boolean): SettingsRoom {
  const [state, setState] = useState<SettingsRoom>(() => ({
    room: typeof window === 'undefined' ? TWO_COLUMN_FLOOR : window.innerWidth,
  }));

  useEffect(() => {
    if (!open) return;
    // Resolved on every open rather than once for the life of the component:
    // the element can be replaced, and this is also the moment the answer
    // actually has to be right. A stale node reports the width it had when it
    // was detached, and nothing about that is obviously wrong on screen.
    const shell = document.querySelector('.appWindow');
    const read = () => {
      const width = shell ? shell.getBoundingClientRect().width : window.innerWidth;
      setState({ room: width });
    };
    read();
    // Docking the player resizes the shell without the WINDOW doing anything -
    // it is a class change, not a resize - so the element is what to watch.
    // The window listener stays for the case where there is no shell to watch,
    // and as a second path in throttled webviews, where ResizeObserver delivery
    // rides the rendering steps and a backgrounded view may not run them.
    const ro = shell ? new ResizeObserver(read) : null;
    ro?.observe(shell!);
    window.addEventListener('resize', read);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', read);
    };
  }, [open]);

  return state;
}

/**
 * Whether settings should stand as a RAIL BESIDE A PANE rather than as a
 * full-screen list you drill into.
 *
 * The question is only ever "is there room for two columns", and it used to
 * ask something else as well: whether the app's shell was SHARED - that is,
 * whether Now Playing was docked beside it. Two columns needed both.
 *
 * Which had it exactly backwards in the case that matters. Sharing the screen
 * with the player is when there is LESS room, not more, so an unfolded phone
 * with nothing playing - the widest, emptiest state the app has - fell through
 * to the phone's drill-in list and gave a thousand points of width to one
 * column of rows. The dock was never the reason for two columns; it was one
 * situation in which two columns still happened to fit.
 *
 * So: room, and nothing else. A folded phone is under the floor and gets the
 * list, which is right for a thumb. Squeezed below the floor by a dock, the
 * same - one readable column beats two clipped ones, which is the trade the
 * floor exists to make.
 */
export function useSettingsIsModal(open: boolean): boolean {
  const { room } = useSettingsRoom(open);
  return room >= TWO_COLUMN_FLOOR;
}

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
