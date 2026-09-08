import { describe, expect, it } from 'vitest';
import { profileAxes } from './profileAxes.ts';
import type { StatsSummary } from './stats.ts';

/**
 * The six numbers behind the radar.
 *
 * A radar is a shape, and a shape is exactly the wrong thing to check a
 * calculation with: a denominator quietly halved moves a vertex, and a moved
 * vertex looks like a different week rather than like a bug. Worse, every one
 * of these axes is a RATIO squashed into 0..1 - so the failures are a value
 * past 1 (a vertex outside the web), a divide by zero on a quiet week (NaN,
 * and the polygon vanishes with no error anywhere), and a ceiling in the
 * readout that no longer matches the one in the arithmetic, which is the file
 * header's own definition of how these charts lie.
 *
 * The translator here returns its key with its values attached, so a case can
 * assert on the numbers a sentence was BUILT from without owning a word of
 * English copy.
 */

const t = (key: string, options?: Record<string, unknown>) =>
  options ? `${key} ${JSON.stringify(options)}` : key;

/** A week with nothing in it, for cases to overwrite one field of. */
function week(over: Partial<StatsSummary> = {}): StatsSummary {
  return {
    range: 'week',
    since: '2026-09-01',
    minutes: 0,
    plays: 0,
    uniqueTracks: 0,
    uniqueArtists: 0,
    topArtists: [],
    topTracks: [],
    topAlbums: [],
    topGenres: [],
    clock: new Array(24).fill(0),
    byDay: [],
    streakDays: 0,
    skipRate: 0,
    completionRate: 0,
    firstListens: 0,
    sound: null,
    ...over,
  };
}

const valueOf = (summary: StatsSummary, key: string) =>
  profileAxes(summary, t).find((a) => a.key === key)!.value;

describe('the axis list itself', () => {
  it('is six axes in a fixed order', () => {
    // The order is the shape. `ListeningRadarSkeleton` draws its empty web
    // from its own copy of this list, so a reorder here makes the placeholder
    // and the real chart label the same spoke differently - and the reader
    // has no way to tell, because both look like radars.
    expect(profileAxes(week(), t).map((a) => a.key)).toEqual([
      'volume',
      'variety',
      'repeat',
      'finish',
      'night',
      'streak',
    ]);
  });

  it('never puts a vertex outside the web, however extreme the week', () => {
    // Every value is drawn as a fraction of the outer ring. One that comes
    // back at 3 does not error - it draws a spike out through the labels.
    const extreme = week({
      minutes: 20_000,
      plays: 4000,
      uniqueTracks: 10,
      uniqueArtists: 3000,
      streakDays: 400,
      completionRate: 1,
      clock: new Array(24).fill(0).map((_, h) => (h >= 21 || h < 5 ? 100 : 0)),
    });
    for (const axis of profileAxes(extreme, t)) {
      expect(axis.value).toBeGreaterThanOrEqual(0);
      expect(axis.value).toBeLessThanOrEqual(1);
    }
  });

  it('gives a silent week six real zeroes rather than six NaNs', () => {
    // Three of these divide by a count that is zero on a week nobody
    // listened. NaN draws nothing at all - the polygon disappears and the
    // page looks like it failed to load rather than like a quiet week.
    for (const axis of profileAxes(week(), t)) {
      expect(Number.isFinite(axis.value)).toBe(true);
      expect(axis.value).toBe(0);
    }
  });
});

describe('volume', () => {
  it('reads ten hours as a full axis, and holds there beyond it', () => {
    expect(valueOf(week({ minutes: 300 }), 'volume')).toBeCloseTo(0.5);
    expect(valueOf(week({ minutes: 600 }), 'volume')).toBe(1);
    expect(valueOf(week({ minutes: 6000 }), 'volume')).toBe(1);
  });

  it('states the ceiling it was measured against', () => {
    // The header's rule: "a normalised axis with a secret denominator is how
    // these charts lie". Both halves go through the same formatter, so the
    // sentence cannot read "10h" beside a locale that writes "10 Std.".
    const detail = profileAxes(week({ minutes: 300 }), t).find((a) => a.key === 'volume')!.detail;
    expect(detail).toContain('"amount":"5h"');
    expect(detail).toContain('"ceiling":"10h"');
  });
});

describe('variety', () => {
  it('reads a new artist every third song as full, and scales below it', () => {
    // The ceiling is 0.33 artists per play. 33 over 100 is exactly it; 32 is
    // just under and must NOT already be full, or the cap is sitting lower
    // than the number the readout claims. A third of the ceiling is a third
    // of the axis - the axis is linear below the cap, not a curve.
    expect(valueOf(week({ plays: 100, uniqueArtists: 33 }), 'variety')).toBe(1);
    expect(valueOf(week({ plays: 100, uniqueArtists: 32 }), 'variety')).toBeLessThan(1);
    expect(valueOf(week({ plays: 100, uniqueArtists: 11 }), 'variety')).toBeCloseTo(1 / 3, 3);
  });

  it('is zero rather than NaN when nothing was played', () => {
    expect(valueOf(week({ plays: 0, uniqueArtists: 4 }), 'variety')).toBe(0);
  });

  it('counts the two halves separately in its readout', () => {
    // Two counted things in one line, and i18next selects a plural form for
    // one `count` at a time - so each half is its own counted key.
    const detail = profileAxes(week({ plays: 90, uniqueArtists: 30 }), t).find((a) => a.key === 'variety')!.detail;
    expect(detail).toContain('profile.artistCount');
    expect(detail).toContain('\\"count\\":30');
    expect(detail).toContain('profile.statsPlayCount');
    expect(detail).toContain('\\"count\\":90');
  });
});

describe('repeat', () => {
  it('measures plays ABOVE one per track, so hearing everything once is zero', () => {
    // The subtraction is the whole axis: without it, a week where every song
    // was played exactly once reads as maximally repetitive.
    expect(valueOf(week({ plays: 40, uniqueTracks: 40 }), 'repeat')).toBe(0);
    expect(valueOf(week({ plays: 60, uniqueTracks: 40 }), 'repeat')).toBeCloseTo(0.5);
    expect(valueOf(week({ plays: 80, uniqueTracks: 40 }), 'repeat')).toBe(1);
  });

  it('cannot go negative when fewer plays than tracks arrive', () => {
    // The two counts come from different columns of the same answer and can
    // disagree; a negative value here drags the vertex through the centre.
    expect(valueOf(week({ plays: 10, uniqueTracks: 40 }), 'repeat')).toBe(0);
  });

  it('says so plainly rather than dividing by no tracks', () => {
    const axis = profileAxes(week({ plays: 5, uniqueTracks: 0 }), t).find((a) => a.key === 'repeat')!;
    expect(axis.value).toBe(0);
    expect(axis.detail).toBe('profile.radarDetailRepeatNone');
  });
});

describe('night', () => {
  it('counts 21:00 to 05:00 and nothing else', () => {
    // Eight hours of the twenty-four. A boundary moved by one hour is a
    // different claim about somebody's habits and looks identical on screen.
    const clock = new Array(24).fill(0);
    clock[22] = 30;
    clock[13] = 30;
    expect(valueOf(week({ clock }), 'night')).toBeCloseTo(0.5);
  });

  it('puts 21:00 inside the night and 20:00 outside it', () => {
    const late = new Array(24).fill(0);
    late[21] = 10;
    expect(valueOf(week({ clock: late }), 'night')).toBe(1);
    const evening = new Array(24).fill(0);
    evening[20] = 10;
    expect(valueOf(week({ clock: evening }), 'night')).toBe(0);
  });

  it('puts 04:00 inside the night and 05:00 outside it', () => {
    const small = new Array(24).fill(0);
    small[4] = 10;
    expect(valueOf(week({ clock: small }), 'night')).toBe(1);
    const dawn = new Array(24).fill(0);
    dawn[5] = 10;
    expect(valueOf(week({ clock: dawn }), 'night')).toBe(0);
  });

  it('survives a server that sends no clock at all', () => {
    // Older hubs answer without it. `clock ?? []` is what keeps the axis at
    // zero instead of throwing inside a reduce mid-render.
    expect(valueOf(week({ clock: undefined as unknown as number[] }), 'night')).toBe(0);
  });

  it('names the hour it split the day at, through Intl', () => {
    const clock = new Array(24).fill(0);
    clock[22] = 10;
    const detail = profileAxes(week({ clock }), t).find((a) => a.key === 'night')!.detail;
    // The boundary is 21:00; how that hour is SAID - "9pm", "21", "21時" - is
    // Intl's business, so what is pinned is that the hour travels as a
    // formatted value rather than as a number baked into the sentence.
    expect(detail).toContain('"hour":"9pm"');
    expect(detail).toContain('"percent":"100%"');
  });
});

describe('finish and streak', () => {
  it('passes the completion rate through untouched', () => {
    expect(valueOf(week({ completionRate: 0.72 }), 'finish')).toBe(0.72);
  });

  it('reads a seven-day streak as full and holds there', () => {
    expect(valueOf(week({ streakDays: 3 }), 'streak')).toBeCloseTo(3 / 7);
    expect(valueOf(week({ streakDays: 7 }), 'streak')).toBe(1);
    expect(valueOf(week({ streakDays: 30 }), 'streak')).toBe(1);
  });

  it('states the streak ceiling as a number rather than as a word', () => {
    const detail = profileAxes(week({ streakDays: 3 }), t).find((a) => a.key === 'streak')!.detail;
    expect(detail).toContain('"days":"3"');
    expect(detail).toContain('"total":"7"');
  });
});
