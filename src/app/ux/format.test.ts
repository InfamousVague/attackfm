/**
 * The house number-to-words rules, checked in every language they claim.
 *
 * `format.ts` makes one large promise and one small, awkward exception to it.
 * The promise is that units, separators and plural forms come from Intl rather
 * than from the catalogue, "because Intl already knows them in every locale".
 * The exception is `formatClock`, which is DELIBERATELY not localised so a
 * seek bar does not twitch once a second.
 *
 * A test that only ran in English would confirm neither. So the locale table
 * below is the eight the app ships (`LOCALE_NAMES` in i18n/index.ts), it
 * includes the right-to-left one, and the plural assertions are on Arabic,
 * where the count genuinely changes the WORD - which is the whole argument the
 * file's header makes for using Intl at all.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatBytes,
  formatClock,
  formatDate,
  formatLocale,
  formatNumber,
  formatTotal,
  setFormatLocale,
} from './format.ts';

/** Every language the app ships. Kept as a literal rather than imported from
 *  i18n/index.ts, so that adding a locale there fails HERE until somebody has
 *  looked at what these formatters do in it. */
const LOCALES = ['en', 'es', 'fr', 'de', 'ja', 'pt', 'zh', 'ar'] as const;

/** The module keeps the locale in a module-level variable on purpose (the
 *  header explains why threading it through 80 call sites was the change this
 *  file exists to avoid), so a test that leaves it set poisons the next one. */
afterEach(() => {
  setFormatLocale('en');
});

describe('the locale itself', () => {
  it('starts in English and reports what it was last set to', () => {
    expect(formatLocale()).toBe('en');
    setFormatLocale('ja');
    expect(formatLocale()).toBe('ja');
  });

  it('CLEARS THE MEMOS when the language changes', () => {
    /*
     * The mechanism, stated as a failure: the formatters are cached in a Map
     * keyed by their OPTIONS, not by the locale, because constructing them per
     * row of a thousand-row list is expensive. That makes `setFormatLocale`
     * responsible for emptying them - and if it forgets, every surface that
     * has already drawn once keeps the previous language's words for the rest
     * of the session while the rest of the app switches around it.
     *
     * The French byte unit is "Go", not "GB", so one call in each direction
     * proves the cache was actually dropped rather than merely that French
     * works from cold.
     */
    expect(formatBytes(15 * 1024 ** 3)).toBe('15 GB');
    setFormatLocale('fr');
    expect(formatBytes(15 * 1024 ** 3)).toBe('15\u202fGo');
    setFormatLocale('en');
    expect(formatBytes(15 * 1024 ** 3)).toBe('15 GB');
  });

  it('is a no-op when the language has not actually changed', () => {
    setFormatLocale('de');
    const first = formatBytes(15 * 1024 ** 3);
    setFormatLocale('de');
    expect(formatBytes(15 * 1024 ** 3)).toBe(first);
    expect(formatLocale()).toBe('de');
  });
});

describe('formatBytes', () => {
  it('uses BINARY units, so a full cache reads as exactly its limit', () => {
    // LIMIT_CHOICES is `gb * 1024 ** 3`. Divide by 1000 instead and a full
    // 15 GB cache reads "16 GB of 15 GB", which is the bug the file names.
    expect(formatBytes(15 * 1024 ** 3)).toBe('15 GB');
    expect(formatBytes(50 * 1024 ** 3)).toBe('50 GB');
  });

  it('keeps one decimal between 1 and 10 GB, and none above', () => {
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(9.94 * 1024 ** 3)).toBe('9.9 GB');
    // The >= 10 arm rounds to whole gigabytes.
    expect(formatBytes(10.4 * 1024 ** 3)).toBe('10 GB');
  });

  it('steps down through MB and kB', () => {
    expect(formatBytes(512 * 1024 ** 2)).toBe('512 MB');
    expect(formatBytes(1024 ** 2)).toBe('1 MB');
    expect(formatBytes(700 * 1024)).toBe('700 kB');
  });

  it('never says "0 kB" for something that exists', () => {
    // Both small arms floor at 1: a held file of 300 bytes is a file, and a
    // size line reading "0 kB" beside a row you can play reads as a bug.
    expect(formatBytes(300)).toBe('1 kB');
    expect(formatBytes(0)).toBe('1 kB');
  });

  it('names the unit in each language, and only Intl decides how', () => {
    const at15gb = 15 * 1024 ** 3;
    const seen: Record<string, string> = {};
    for (const locale of LOCALES) {
      setFormatLocale(locale);
      seen[locale] = formatBytes(at15gb);
    }
    // French really does abbreviate octets, and Arabic really does have its
    // own short form. A hard-coded "GB" - which is what this file replaced -
    // is wrong in two of the eight.
    //
    // And the SEPARATOR is not a space in half of them: French puts a narrow
    // no-break space between the number and the unit, German a no-break one.
    // Written as escapes because they are invisible in a diff, and because
    // `${n} GB` - the shape this file replaced - cannot produce either.
    expect(seen.fr).toBe('15\u202fGo');
    expect(seen.ar).toBe('15 غ.ب');
    expect(seen.en).toBe('15 GB');
    expect(seen.de).toBe('15\u00a0GB');
  });

  it('groups the decimal the way each language groups it', () => {
    setFormatLocale('de');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1,5\u00a0GB');
    setFormatLocale('en');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
  });
});

describe('formatClock', () => {
  it('floors, and can never print a sixtieth second', () => {
    // One of the five copies this replaced rounded inside the seconds and
    // could print "1:60".
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(119.999)).toBe('1:59');
    expect(formatClock(60)).toBe('1:00');
  });

  it('pads the seconds and does not pad the minutes', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(3599)).toBe('59:59');
    expect(formatClock(3600)).toBe('60:00');
  });

  it('wears the placeholder for a duration nobody has yet', () => {
    // A deck reports Infinity on a transcode stream and NaN before metadata.
    expect(formatClock(Infinity)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(null)).toBe('0:00');
    expect(formatClock(undefined)).toBe('0:00');
    expect(formatClock(undefined, '--:--')).toBe('--:--');
  });

  it('clamps a negative position rather than printing "-1:-5"', () => {
    expect(formatClock(-30)).toBe('0:00');
  });

  it('IS THE SAME IN EVERY LANGUAGE, including the right-to-left one', () => {
    /*
     * The deliberate exception, and the reason it is deliberate: two clocks
     * sit either side of a seek bar changing once a second, and a locale whose
     * digits are a different width would twitch the layout for the length of
     * every song.
     *
     * Asserted as ASCII rather than as a fixed string so this keeps meaning
     * the same thing if CLDR ever changes which numbering system bare `ar`
     * resolves to - the promise is Latin digits and a colon, whatever ICU
     * would otherwise prefer.
     */
    for (const locale of LOCALES) {
      setFormatLocale(locale);
      expect(formatClock(330)).toBe('5:30');
      expect(formatClock(330)).toMatch(/^[0-9]+:[0-9]{2}$/);
    }
  });
});

describe('formatTotal', () => {
  it('stays in minutes below an hour', () => {
    expect(formatTotal(42 * 60)).toBe('42 min');
    expect(formatTotal(59 * 60)).toBe('59 min');
  });

  it('rounds UP into an hour rather than printing "60 min"', () => {
    // 59m40s rounds to 60 minutes, and 60 is not less than 60, so it takes
    // the hour arm with no remainder. Pinned because the boundary is the one
    // place the two arms could each claim the answer.
    expect(formatTotal(59 * 60 + 40)).toBe('1 hr');
  });

  it('drops the minutes when a list is a whole number of hours', () => {
    expect(formatTotal(2 * 3600)).toBe('2 hr');
  });

  it('joins the two units when there is a remainder', () => {
    expect(formatTotal(2 * 3600 + 20 * 60)).toBe('2 hr 20 min');
  });

  it('speaks each language, including ones that put no space in', () => {
    setFormatLocale('de');
    expect(formatTotal(2 * 3600 + 20 * 60)).toBe('2 Std. 20 Min.');
    setFormatLocale('ja');
    expect(formatTotal(42 * 60)).toBe('42 分');
    setFormatLocale('zh');
    // Chinese attaches the unit with no space; a hand-rolled `${n} min` could
    // not produce this.
    expect(formatTotal(42 * 60)).toBe('42分钟');
    setFormatLocale('ar');
    expect(formatTotal(2 * 3600 + 20 * 60)).toBe('2 س 20 د');
  });
});

describe('formatNumber', () => {
  it('groups thousands the way the language does', () => {
    setFormatLocale('en');
    expect(formatNumber(1234567)).toBe('1,234,567');
    setFormatLocale('de');
    // German swaps the roles of the comma and the dot outright - which is the
    // failure mode of any hand-written `toLocaleString('en-US')`.
    expect(formatNumber(1234567)).toBe('1.234.567');
  });

  it('passes its options through', () => {
    setFormatLocale('en');
    expect(formatNumber(0.4567, { style: 'percent', maximumFractionDigits: 1 })).toBe('45.7%');
  });
});

describe('formatDate', () => {
  const tuesday = new Date(Date.UTC(2026, 8, 8, 12, 0, 0));

  it('names the weekday in the current language', () => {
    // useHomeFeed builds the daylist heading out of exactly this call.
    setFormatLocale('en');
    expect(formatDate(tuesday, { weekday: 'long' })).toBe('Tuesday');
    setFormatLocale('ja');
    expect(formatDate(tuesday, { weekday: 'long' })).toBe('火曜日');
    setFormatLocale('ar');
    expect(formatDate(tuesday, { weekday: 'long' })).toBe('الثلاثاء');
  });

  it('memoises per options shape, and re-memoises after a language change', () => {
    setFormatLocale('en');
    expect(formatDate(tuesday, { weekday: 'long' })).toBe('Tuesday');
    setFormatLocale('es');
    expect(formatDate(tuesday, { weekday: 'long' })).toBe('martes');
  });

  it('takes a number as readily as a Date', () => {
    setFormatLocale('en');
    expect(formatDate(tuesday.getTime(), { weekday: 'long' })).toBe('Tuesday');
  });
});

describe('formatAgo', () => {
  const now = Date.UTC(2026, 8, 8, 12, 0, 0);
  const ago = (seconds: number) => formatAgo(now - seconds * 1000, now);

  it('picks the largest unit the gap has reached', () => {
    setFormatLocale('en');
    expect(ago(3 * 86400)).toBe('3 days ago');
    expect(ago(2 * 3600)).toBe('2 hours ago');
    expect(ago(90)).toBe('1 minute ago');
    expect(ago(400 * 86400)).toBe('last year');
  });

  it('reads forwards as well as backwards', () => {
    setFormatLocale('en');
    expect(formatAgo(now + 2 * 3600 * 1000, now)).toBe('in 2 hours');
  });

  it('says "now" rather than "in 0 seconds"', () => {
    // `numeric: 'auto'` is what buys this, plus "yesterday" and "last year".
    setFormatLocale('en');
    expect(ago(0)).toBe('now');
    expect(ago(1 * 86400)).toBe('yesterday');
  });

  it('falls through to seconds for a gap smaller than a minute', () => {
    setFormatLocale('en');
    // The loop's `|| step === 'second'` arm: nothing else matches, and the
    // answer must not be an empty string.
    expect(ago(20)).toBe('20 seconds ago');
  });

  it('GETS THE ARABIC PLURAL FORMS RIGHT, which is the whole argument', () => {
    /*
     * The file's header claims Intl "knows that Arabic counts '3 days ago'
     * with a different word for 3 than for 11". This is that claim, executed.
     *
     * Three distinct forms for one unit, from one call: أيام (few, 3-10),
     * يومًا (many, 11-99) and يوم (other, 100). The four hand-rolled copies
     * this replaced said `${n} days ago` and could express exactly one.
     */
    setFormatLocale('ar');
    // Seconds, because the ladder's `week` step takes over above six days and
    // the interesting boundaries all live below sixty:
    //   1  singular      2  DUAL        3-10 few        11+ many
    expect(ago(1)).toBe('قبل ثانية واحدة');
    expect(ago(2)).toBe('قبل ثانيتين');
    expect(ago(3)).toBe('قبل 3 ثوانِ');
    expect(ago(10)).toBe('قبل 10 ثوانِ');
    expect(ago(11)).toBe('قبل 11 ثانية');
    // Four forms of one word from one call. `n === 1 ? a : b` can express two.
    expect(new Set([ago(1), ago(2), ago(3), ago(11)]).size).toBe(4);
    // And the day's own few-form, which is a different word again.
    expect(ago(3 * 86400)).toBe('قبل 3 أيام');
    // The dual once more, forwards.
    expect(formatAgo(now + 2 * 3600 * 1000, now)).toBe('خلال ساعتين');
  });

  it('answers in every language the app ships', () => {
    const seen = LOCALES.map((locale) => {
      setFormatLocale(locale);
      return ago(3 * 86400);
    });
    expect(seen).toHaveLength(LOCALES.length);
    // Every one is a real sentence, and no two languages produced the same
    // one - which is what fails if the locale were ever ignored.
    for (const line of seen) expect(line.length).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(LOCALES.length);
  });

  it('defaults `now` to the wall clock', () => {
    setFormatLocale('en');
    expect(formatAgo(Date.now() - 3 * 86400 * 1000)).toBe('3 days ago');
  });
});
