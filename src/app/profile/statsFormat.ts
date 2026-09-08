import type { StatsRange } from './stats.ts';
import { formatDate, formatLocale, formatNumber } from '../ux/format.ts';

/** Ranges, axis labels and little formatters for the stats page. */

/**
 * The four ranges, as keys rather than words.
 *
 * This table is built at import time, before any provider exists, so a
 * translated label here would be resolved once - in whatever language the app
 * happened to boot in - and the picker in Settings would then change every
 * other string on the page but not these four. Callers resolve at render.
 *
 * `sentenceKey` is a second entry rather than `label.toLowerCase()`, which is
 * what the hero line used to do: only some languages lower-case a word when it
 * moves mid-sentence, and German never does.
 */
export const RANGES: { id: StatsRange; labelKey: string; sentenceKey: string }[] = [
  { id: 'week', labelKey: 'profile.statsRangeWeek', sentenceKey: 'profile.statsRangeWeekInline' },
  { id: 'month', labelKey: 'profile.statsRangeMonth', sentenceKey: 'profile.statsRangeMonthInline' },
  { id: 'year', labelKey: 'profile.statsRangeYear', sentenceKey: 'profile.statsRangeYearInline' },
  { id: 'all', labelKey: 'profile.statsRangeAll', sentenceKey: 'profile.statsRangeAllInline' },
];

/** The hours the clock's axis names. Four is enough to orient by. */
export const AXIS_HOURS = new Set([0, 6, 12, 18]);

// Built per locale and kept: the clock strip calls fmtHour 24 times a render,
// and constructing an Intl formatter is the expensive half of using one.
let hourFmt: Intl.DateTimeFormat | null = null;
let hourFmtLocale = '';

function hourParts(): Intl.DateTimeFormat {
  const locale = formatLocale();
  if (!hourFmt || hourFmtLocale !== locale) {
    hourFmt = new Intl.DateTimeFormat(locale, { hour: 'numeric' });
    hourFmtLocale = locale;
  }
  return hourFmt;
}

/**
 * An hour as people say it: in English "12a", "2p" - but 14 in German, which
 * does not halve the day at all, and 14時 in Japanese.
 *
 * This was `hour < 12 ? `${hour}a` : ...`, which is not a formatting choice but
 * a claim that every language runs a twelve-hour clock and marks it with one
 * Latin letter. Intl knows each locale's own hour cycle and its own marker.
 *
 * The one liberty taken is the space before an AM/PM marker, which is dropped:
 * left whole, en-US reads "12 AM" against the old "12a", and these labels sit
 * in a strip of twenty-four columns whose stylesheet this file cannot reach.
 * Only that marker is glued on and lower-cased - locales that end the hour
 * with a WORD instead (German's "Uhr", French's "h") keep their spacing and
 * their capital, because "14uhr" is not German.
 */
export function fmtHour(hour: number): string {
  // A fixed date so only the hour varies; the day itself is never shown.
  const parts = hourParts().formatToParts(new Date(2000, 0, 1, hour));
  const marker = parts.find((part) => part.type === 'dayPeriod');
  if (!marker) return parts.map((part) => part.value).join('');
  const locale = formatLocale();
  return parts
    .filter((part) => !(part.type === 'literal' && part.value.trim() === ''))
    .map((part) => (part === marker ? part.value.toLocaleLowerCase(locale) : part.value))
    .join('');
}

/** "2026-08-11" → "Aug 11", in the locale's month names and its own order -
 *  several languages put the day first, and Intl is the thing that knows. */
export function fmtDay(day: string): string {
  const ms = dayToLocalMs(day);
  return Number.isNaN(ms) ? day : fmtDayMs(ms);
}

/** The same short day label from a timestamp, for a chart axis that counts in
 *  milliseconds rather than in date strings. */
export function fmtDayMs(ms: number): string {
  return formatDate(ms, { month: 'short', day: 'numeric' });
}

/** "2026-08-11" → local epoch ms, for the chart's time axis. Split by hand:
 *  `new Date` on a bare date string parses it as UTC midnight, which shifts
 *  the label a day west of Greenwich. */
export function dayToLocalMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

/**
 * Chart-axis minutes: whole hours once the numbers are big.
 *
 * The unit comes from Intl rather than a catalogue entry, for the reason
 * ux/format.ts gives at length - not least that some locales write the unit
 * before the number, which a template literal cannot do.
 */
export function fmtAxisMinutes(v: number): string {
  const big = v >= 120;
  return formatNumber(big ? Math.round(v / 60) : Math.round(v), {
    style: 'unit',
    unit: big ? 'hour' : 'minute',
    unitDisplay: 'narrow',
    maximumFractionDigits: 0,
  });
}

/**
 * A span of minutes at tile size: whole hours once it is worth an hour.
 *
 * The "h" and the "m" were hard-coded letters, which is an English twelve-hour
 * reading of a unit; Intl knows the narrow unit in every locale, and knows the
 * locales that write it before the number.
 */
export function hoursLabel(minutes: number): string {
  const big = minutes >= 60;
  const value = big ? (minutes / 60 >= 10 ? Math.round(minutes / 60) : Math.round(minutes / 6) / 10) : minutes;
  return formatNumber(value, {
    style: 'unit',
    unit: big ? 'hour' : 'minute',
    unitDisplay: 'narrow',
    maximumFractionDigits: 1,
  });
}
