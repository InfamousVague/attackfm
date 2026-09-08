import { describe, expect, it } from 'vitest';
import { clockInWords } from './djClock.ts';

/**
 * The clock in words - the eyebrow over the deck's "for right now" card.
 *
 * A frozen clock and a pinned locale, because both are inputs here and
 * neither is stable in a test runner. The weekday comes from
 * `toLocaleDateString`, so the assertions below say "starts with Saturday"
 * rather than pinning a whole sentence: the part number is the module's
 * decision, the weekday's spelling is the platform's.
 *
 * A local Date, deliberately - `getHours()` is what the module reads, so a
 * UTC-constructed fixture would test the runner's timezone instead of the
 * boundaries.
 */

/** Saturday 2026-09-05, at the given local hour. */
const saturdayAt = (hour: number) => new Date(2026, 8, 5, hour, 30, 0);
/** Sunday 2026-09-06, at the given local hour. */
const sundayAt = (hour: number) => new Date(2026, 8, 6, hour, 30, 0);

describe('clockInWords', () => {
  it('drops the weekday entirely in the small hours', () => {
    // Past midnight nobody thinks of it as Saturday any more - which is why
    // these two answers carry no day at all.
    expect(clockInWords(sundayAt(0))).toBe('Late, late');
    expect(clockInWords(sundayAt(3))).toBe('Late, late');
    expect(clockInWords(sundayAt(4))).toBe('Early, early');
    expect(clockInWords(sundayAt(5))).toBe('Early, early');
  });

  it('picks the weekday back up at six', () => {
    // The boundary, from both sides: at 5 there is no day, at 6 there is.
    expect(clockInWords(sundayAt(5))).toBe('Early, early');
    expect(clockInWords(sundayAt(6))).toMatch(/ morning$/);
  });

  it('names the four quarter-days', () => {
    expect(clockInWords(saturdayAt(6))).toMatch(/ morning$/);
    expect(clockInWords(saturdayAt(11))).toMatch(/ morning$/);
    expect(clockInWords(saturdayAt(12))).toMatch(/ afternoon$/);
    expect(clockInWords(saturdayAt(16))).toMatch(/ afternoon$/);
    expect(clockInWords(saturdayAt(17))).toMatch(/ evening$/);
    expect(clockInWords(saturdayAt(20))).toMatch(/ evening$/);
    expect(clockInWords(saturdayAt(21))).toMatch(/ night$/);
    expect(clockInWords(saturdayAt(23))).toMatch(/ night$/);
  });

  it('carries the day the clock is actually on', () => {
    const sat = clockInWords(saturdayAt(21));
    const sun = clockInWords(sundayAt(21));
    expect(sat).not.toBe(sun);
    // Both end in the same part; only the day differs.
    expect(sat.endsWith('night') && sun.endsWith('night')).toBe(true);
  });

  it('reads the clock now when nothing is handed to it', () => {
    // The default argument is the whole point of the signature - a caller
    // that has no Date in hand must not get an empty string.
    expect(clockInWords()).toMatch(/\S/);
  });
});
