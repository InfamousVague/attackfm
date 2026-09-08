import { describe, expect, it } from 'vitest';
import { greetingFor } from './greeting.ts';

/**
 * The hour of the day, as the four things a home page can say about it.
 *
 * The rule worth pinning is the CUTS, not the words: 5, 12 and 18, each
 * exclusive at the bottom and inclusive at the top of the hour before it. An
 * off-by-one here is a greeting that says "good evening" at half past five in
 * the afternoon, which nobody reports as a bug and everybody notices.
 *
 * The words themselves are pre-i18n English, and the greeting Home actually
 * draws now picks a catalogue key at these same three cuts - the hour chooses
 * a MEANING, not a string. So the assertions below are about which of the
 * four meanings each hour belongs to, and they are written as comparisons
 * between hours wherever saying so does not need the English.
 */

describe('greetingFor', () => {
  it('cuts the day at 5, 12 and 18, and nowhere else', () => {
    // The three boundaries, each checked from both sides - the only places
    // the function can be wrong by one.
    expect(greetingFor(4)).not.toBe(greetingFor(5));
    expect(greetingFor(11)).not.toBe(greetingFor(12));
    expect(greetingFor(17)).not.toBe(greetingFor(18));
    // ...and every hour in between belongs with its neighbour.
    for (const [from, to] of [
      [0, 4],
      [5, 11],
      [12, 17],
      [18, 23],
    ]) {
      for (let h = from!; h <= to!; h += 1) {
        expect(greetingFor(h)).toBe(greetingFor(from!));
      }
    }
  });

  it('names the four periods, in the order the day runs', () => {
    expect(greetingFor(2)).toBe('Up late');
    expect(greetingFor(9)).toBe('Good morning');
    expect(greetingFor(15)).toBe('Good afternoon');
    expect(greetingFor(21)).toBe('Good evening');
  });

  it('opens the day at midnight with the LATE greeting, not the morning one', () => {
    /*
     * The one cut a reader would get wrong writing this from memory. 00:00 to
     * 04:59 is the end of somebody's night, not the start of their day, and
     * "good morning" at two in the morning is the app telling a listener it
     * has no idea when they are.
     */
    expect(greetingFor(0)).toBe(greetingFor(4));
    expect(greetingFor(0)).not.toBe(greetingFor(5));
  });

  it('answers with one of the four for every hour a clock can give', () => {
    // The function takes `new Date().getHours()`, so 0-23 is its whole
    // domain and there is no hour it may leave without a greeting.
    const said = new Set(Array.from({ length: 24 }, (_, h) => greetingFor(h)));
    expect(said.size).toBe(4);
    expect([...said].every((s) => s.length > 0)).toBe(true);
  });
});
