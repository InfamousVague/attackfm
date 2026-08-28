import { accentOptions } from '@glacier/tokens';
import { createContext, useEffect, useState, type ReactNode } from 'react';
import { BRAND_ACCENTS } from './brandAccents.ts';
import type { ThemePreference } from './themePresets.ts';

/**
 * What the search field matches beyond the visible words: each pane's own
 * vocabulary, written by hand because nothing else knows that "crossfade"
 * lives in Playback or "invite" under Servers. Lowercase, space-separated;
 * label and summary are always matched too.
 */
export const PANE_KEYWORDS: Record<string, string> = {
  appearance:
    'theme dark light accent color colour scale text size dawn boreal ember midnight alpine lyrics video clips canvas haptics vibration shake flick motion feel',
  general: 'library songs folder music directory source stats upload send add',
  // The equalizer left for the sound console long ago, and gapless/repeat
  // never had rows here - phantom words that matched this pane made the
  // search LOOK broken ("eq" landed you somewhere with no EQ in it).
  playback:
    'crossfade sleep timer pause style shuffle quality volume night mode mono auto dj bitrate lossless data saver streaming',
  account:
    'account sign in log out username devices seat speakers household invite link qr pair where you listen rename',
  server: 'server connect sign in url mirror network host latency copy library',
  storage: 'cache offline downloads space disk limit pins clear wifi wi-fi mobile data cellular',
  notifications: 'push alerts recap weekly interrupt bell notifications news downloads finished',
  plugins: 'plugin extension import spotify buy discover sources',
  privacy: 'privacy history scrobble tracking metadata lookups lyrics share position telemetry friends',
  diagnostics: 'diagnostics problems errors log report broken crash push notifications debug',
  about: 'version update check whats new shell licenses github',
  developer: 'developer dev tools debug build bundle ota cache storage keys performance fps memory test notice flags',
  'local-ai': 'local ai model ollama llm endpoint embeddings curator dj mixes stations health owner report',
  handbook:
    'handbook guide manual documentation docs how it works help plugin develop developer api build publish gestures audiobook audiobooks books read along narrator transcription',
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
    pane: 'appearance',
    label: 'Video clips on Now Playing',
    description: "The song's short looping clip behind the full player.",
    keywords: 'canvas video clip loop spotify animation background data cellular battery',
  },
  {
    id: 'auto-upload',
    pane: 'general',
    label: 'Send new music automatically',
    description: "Uploads anything in this machine's music folder the server does not have.",
    keywords: 'upload sync folder send push library bandwidth add music import files automatic',
  },
  {
    id: 'streaming-quality',
    pane: 'playback',
    label: 'Streaming quality',
    description: 'Lossless sends the original file; Data saver re-encodes to a bitrate you pick.',
    keywords: 'quality bitrate lossless data saver transcode cellular metered bandwidth kbps',
  },
  {
    id: 'haptics',
    pane: 'appearance',
    label: 'Haptics',
    description: 'Ticks from the Taptic Engine as you tap, play, and spin the disc.',
    keywords: 'haptics vibration vibrate taptic feedback feel buzz',
  },
  {
    id: 'shake-flick',
    pane: 'appearance',
    label: 'Shake and flick',
    description: 'Shake to change shuffle, flick left or right to change songs, on Now Playing.',
    keywords: 'shake flick motion gesture accelerometer tilt skip',
  },
  {
    id: 'sleep-timer',
    pane: 'playback',
    label: 'Sleep timer',
    description: 'Fades out and pauses when the time is up.',
    keywords: 'sleep timer bedtime night stop fade minutes',
  },
  {
    id: 'crossfade',
    pane: 'playback',
    label: 'Crossfade',
    description: 'Blends the end of one song into the start of the next.',
    keywords: 'crossfade blend fade transition seconds gapless',
  },
  {
    id: 'device-rename',
    pane: 'account',
    label: 'Device name',
    description: 'What this device is called in every picker on the account.',
    keywords: 'device name rename phone label picker connect',
  },
  {
    id: 'dev-mode',
    pane: 'developer',
    label: 'Developer mode',
    description: 'Shows the Developer page and Diagnostics in Settings.',
    keywords: 'developer dev mode tools debug hidden unlock',
  },
  {
    id: 'notify-os',
    pane: 'notifications',
    label: 'Show them on this device',
    description: "Puts the app's news in your phone's notification tray, so it reaches you without the app open.",
    keywords: 'notifications push phone tray system os alerts banner lock screen device notify popup',
  },
  {
    id: 'notify-os-test',
    pane: 'notifications',
    label: 'Send a test one',
    description: 'Puts one notification in the tray now, to check they arrive.',
    keywords: 'test notification try check send sample verify tray',
  },
  {
    id: 'notify-verbose',
    pane: 'notifications',
    label: 'Verbose notifications',
    description: 'Ring for background work too: downloads starting, songs being pulled into stems, the AI running.',
    keywords: 'verbose notifications background stems ai downloads started chatty detail',
  },
  {
    // 'ai-url', not 'ai-endpoint': the anchor is built from the field key
    // ('url'), and revealSetting fails SILENTLY on a miss - the pane simply
    // opens at the top and nothing flashes, which reads as search being flaky
    // rather than as a typo here.
    id: 'ai-url',
    pane: 'local-ai',
    label: 'Model endpoint',
    description: 'Where the server sends its AI requests - an Ollama or any OpenAI-compatible origin.',
    keywords: 'ai endpoint url ollama model local llm server',
  },
  {
    id: 'ai-do-discover',
    pane: 'local-ai',
    label: 'Find me new music',
    description: 'Ask the server to go looking for artists around what you have been playing.',
    keywords: 'ai discover find new music harvest recommendations suggestions look',
  },
  {
    id: 'ai-do-mix',
    pane: 'local-ai',
    label: 'Make me a new mix',
    description: 'Rebuild the mixes on your home screen from your recent listening.',
    keywords: 'ai mix mixes rebuild home shuffle playlist make new',
  },
  {
    id: 'ai-do-dates',
    pane: 'local-ai',
    label: 'Top up Music Date',
    description: 'Look for something you do not own and ask for it, so the deck has more to show.',
    keywords: 'ai music date dates deck audition top up refresh cards more',
  },
  {
    id: 'ai-taste',
    pane: 'local-ai',
    label: 'Your listening moods',
    description: 'What the machine reads off your last three weeks - the moods, their tempo and energy, and the stations built on them.',
    keywords: 'ai mood moods taste profile clusters stations listening recent vibe',
  },
  {
    id: 'ai-do-curate',
    pane: 'local-ai',
    label: 'Full curation pass',
    description: 'Read the library, rebuild the lists and look for more, all in one go.',
    keywords: 'ai curate pass full run now curator enrich refresh everything',
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
  {
    id: 'import-server',
    // The NAMESPACED section id, because pluginHooks builds a plugin pane's id
    // as `${plugin.id}:${section.id}`. A bare 'downloads' here matches nothing
    // and both search surfaces drop the entry silently and forever - which is
    // also, used correctly, what makes it disappear when the plugin is off.
    pane: 'spotify-import:downloads',
    label: 'Where downloads run',
    description: 'Which server fetches imported links, before the songs are copied across to your library.',
    keywords: 'import download server which box spotiflac peer hub mirror where runs downloader sync copy',
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

/**
 * Scroll a just-opened pane to one row and flash it. The delay covers the
 * pane mounting (and, on the phone, the push animation landing) - a scroll
 * fired into a pane that is not there yet lands nowhere, silently. Best
 * effort by design: a row that is gated off (signed out, wrong platform)
 * simply is not found, and the pane opening at its top is the honest answer.
 */
export function revealSetting(id: string): void {
  /*
   * Said out loud BEFORE the scroll timer, for panes made of sub-pages.
   *
   * The query below is a raw DOM lookup, and a row living on a pane's
   * non-default page simply is not in the DOM 400ms after the pane opens - the
   * search hit lands at the top with no flash and no error, which reads as
   * search being flaky. A pane with pages listens for this, switches to the
   * page that owns the id, and the ordinary timer then finds the row where it
   * always would have. Panes without pages hear nothing and lose nothing.
   */
  window.dispatchEvent(new CustomEvent('afm-reveal-setting', { detail: { id } }));
  window.setTimeout(() => {
    const el = document.querySelector<HTMLElement>(`[data-setting="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('setk-flash');
    window.setTimeout(() => el.classList.remove('setk-flash'), 1700);
  }, 400);
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

/**
 * A pane's way of sending you to another pane ("Set up under Servers"), no
 * matter which shell is hosting it: the desktop modal provides its tab
 * setter, the phone sheet its drill. Null outside settings, so a component
 * that also renders elsewhere simply has no button to offer.
 */
export const SettingsNavContext = createContext<((sectionId: string) => void) | null>(null);

/**
 * The clusters' names. The numeric `group` on each section always decided
 * which card a row filed into on the touch list; these give the cards words,
 * so the clustering reads as intent rather than as accidental gaps. The same
 * labels head the desktop rail's runs, which used to ignore `group` entirely.
 */
export const SETTINGS_GROUPS: readonly { id: number; label: string }[] = [
  { id: 0, label: 'Look & sound' },
  { id: 1, label: 'Your stuff' },
  { id: 2, label: 'The machinery' },
  { id: 3, label: 'Reference' },
];

export function settingsGroupLabel(id: number | undefined): string | null {
  return SETTINGS_GROUPS.find((g) => g.id === id)?.label ?? null;
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
