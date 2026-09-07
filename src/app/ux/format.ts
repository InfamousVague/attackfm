/**
 * The house number-to-words rules, in one place.
 *
 * Before this file, seven surfaces each carried their own byte formatter -
 * split between decimal and binary units, so a full 15 GB cache could read
 * "16 GB of 15 GB" on one line, and the same collector ledger showed "54 GB"
 * in Settings and "50 GB" in the Booth. Same story for mm:ss clocks (five
 * copies, one of which could print "1:60") and list running-times (three).
 * One implementation each, so every surface agrees with every other.
 *
 * THE UNITS ARE WORDS TOO. "GB", "min", "hr", "3 days ago" - every one of them
 * is English, and they were hard-coded here while the rest of the app learned
 * to speak. They are not translated through the catalogue, because Intl
 * already knows them in every locale and knows the things a catalogue entry
 * would get wrong: where the unit goes relative to the number (before it, in
 * some locales), which separator groups the thousands, and that Arabic counts
 * "3 days ago" with a different word for 3 than for 11.
 *
 * So this file holds the locale, and every formatter asks Intl.
 */

/**
 * Whose conventions to use. Set by LocaleShell whenever the language changes,
 * rather than passed to every call: these are called from deep inside render
 * trees and from plain .ts helpers with no context to read, and threading a
 * locale through all 80 call sites would be the change this file exists to
 * avoid. A module-level value is the same shape the old hard-coded English
 * was - it is just no longer hard-coded.
 */
let locale = 'en';

/** Called by LocaleShell. Also clears the memos, which are per-locale. */
export function setFormatLocale(next: string): void {
  if (next === locale) return;
  locale = next;
  numberFmts.clear();
  dateFmts.clear();
  relativeFmt = null;
}

export function formatLocale(): string {
  return locale;
}

// Intl formatters are expensive to construct and cheap to reuse, and these are
// called per row in lists that can be thousands long.
const numberFmts = new Map<string, Intl.NumberFormat>();
const dateFmts = new Map<string, Intl.DateTimeFormat>();
let relativeFmt: Intl.RelativeTimeFormat | null = null;

function num(options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = JSON.stringify(options);
  let fmt = numberFmts.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat(locale, options);
    numberFmts.set(key, fmt);
  }
  return fmt;
}

/** A plain count, grouped the way this locale groups. */
export function formatNumber(value: number, options: Intl.NumberFormatOptions = {}): string {
  return num(options).format(value);
}

/**
 * Bytes as a short human size, in BINARY units - the base the cache budget
 * itself is set in (`LIMIT_CHOICES` is `gb * 1024 ** 3`), so a full cache
 * reads as exactly its limit. The UNIT comes from Intl; only the choice of
 * which unit, and how many decimals, is ours.
 */
export function formatBytes(bytes: number): string {
  const g = bytes / 1024 ** 3;
  if (g >= 10) return unit(Math.round(g), 'gigabyte');
  if (g >= 1) return unit(Number(g.toFixed(1)), 'gigabyte', 1);
  const m = bytes / 1024 ** 2;
  if (m >= 1) return unit(Math.max(1, Math.round(m)), 'megabyte');
  return unit(Math.max(1, Math.round(bytes / 1024)), 'kilobyte');
}

function unit(value: number, u: string, decimals = 0): string {
  return num({
    style: 'unit',
    unit: u,
    unitDisplay: 'short',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/**
 * Seconds as a mm:ss clock.
 *
 * DELIBERATELY NOT LOCALISED, and this is the one formatter here that is not.
 * A clock sits under a moving seek bar and next to another clock, both of them
 * changing once a second; the pair has to hold a fixed width or the layout
 * twitches for the length of every song. Arabic's own digits (٥:٣٠) are wider
 * and would do exactly that, and every music player that ships in Arabic keeps
 * Latin digits here for the same reason. The COLON is universal.
 *
 * Floors rather than rounds - a clock must never show a second that has not
 * happened, and rounding inside the seconds is how one copy of this managed to
 * print "1:60". The placeholder is what a missing duration wears: the deck's
 * running clock wants "0:00", a track row wants "--:--".
 */
export function formatClock(
  seconds: number | null | undefined,
  placeholder = '0:00',
): string {
  // A deck reports Infinity (transcode stream) or NaN until metadata lands.
  if (seconds == null || !Number.isFinite(seconds)) return placeholder;
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}

/** The running time of a whole list, in the units it deserves. */
export function formatTotal(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return unit(mins, 'minute');
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  // Two units side by side. Intl has no "1 hr 20 min" compound, so they are
  // joined - with the locale's own list separator rather than a space, which
  // is what puts them in the right ORDER in an RTL line.
  const parts = [unit(hours, 'hour')];
  if (rest) parts.push(unit(rest, 'minute'));
  return parts.join(' ');
}

/** A date, at the length the surface has room for. */
export function formatDate(
  value: Date | number,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium' },
): string {
  const key = JSON.stringify(options);
  let fmt = dateFmts.get(key);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat(locale, options);
    dateFmts.set(key, fmt);
  }
  return fmt.format(value);
}

const AGO_STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
  ['second', 1],
];

/**
 * "3 days ago", "in 2 hours" - and the six Arabic forms of each, which is why
 * this replaced four hand-rolled copies (CuratorSettings, LocalAiPane,
 * RegistryFriends, NotifyBell) that each said `${n} days ago` in English.
 */
export function formatAgo(value: Date | number, now: number = Date.now()): string {
  if (!relativeFmt) relativeFmt = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const seconds = (Number(value) - now) / 1000;
  const magnitude = Math.abs(seconds);
  for (const [step, size] of AGO_STEPS) {
    if (magnitude >= size || step === 'second') {
      return relativeFmt.format(Math.round(seconds / size), step);
    }
  }
  return relativeFmt.format(0, 'second');
}
