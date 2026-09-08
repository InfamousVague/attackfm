import { describe, expect, it } from 'vitest';
import { clampScale, UI_SCALES } from './uiScale.ts';

/**
 * The guard on the one number that resizes the whole app.
 *
 * `AppearanceProvider` writes this to the root font size, and the app is built
 * in rem throughout - so a value that gets past this function is not a
 * setting that looks wrong, it is an interface at 4000% or one that vanishes.
 * Worse, the number arrives from OUTSIDE: `readStored` parses it out of
 * localStorage, which somebody can edit and an older build may have written
 * differently.
 *
 * Two failures, opposite and equally quiet. Let something through and the app
 * is unusable with no error anywhere; refuse something legal and the picker
 * on the Appearance pane silently snaps back to normal every time it is
 * touched, which reads as the setting not working.
 */

describe('clampScale', () => {
  it('lets every value the picker offers through UNCHANGED', () => {
    // The failure this catches is a bound tightened by hand - a clamp to
    // 0.9..1.2 leaves the two end options in the list and unreachable, and
    // the picker snaps back with no explanation.
    for (const scale of UI_SCALES) {
      expect(clampScale(scale)).toBe(scale);
    }
  });

  it('holds anything beyond the ends at the ends', () => {
    expect(clampScale(0.1)).toBe(0.85);
    expect(clampScale(4)).toBe(1.25);
    // Negative is not merely small: as a font-size percentage it is invalid,
    // and the browser would keep the previous value while the setting claims
    // to have changed.
    expect(clampScale(-3)).toBe(0.85);
  });

  it('answers NORMAL, not the smallest step, for anything that is not a number', () => {
    /*
     * This is the branch that matters most, and it is the one an "improvement"
     * breaks: falling through to Math.max/Math.min with a NaN returns NaN,
     * which is not a size at all - `font-size: NaN%` is dropped by the
     * browser, so the app keeps whatever it had and the preference is
     * silently inert. And clamping to MIN instead of 1 would shrink the whole
     * interface for anyone whose stored value was written by a build that did
     * not have this field yet.
     */
    expect(clampScale(undefined)).toBe(1);
    expect(clampScale(null)).toBe(1);
    expect(clampScale('1.1')).toBe(1);
    expect(clampScale(Number.NaN)).toBe(1);
    expect(clampScale(Number.POSITIVE_INFINITY)).toBe(1);
    expect(clampScale({})).toBe(1);
  });

  it('keeps a value between two steps rather than snapping to one', () => {
    // Deliberately a range, not a whitelist: a scale saved by an older build
    // whose steps were different is still a usable size, and rounding it to
    // the nearest offered step would move somebody's interface for them.
    expect(clampScale(0.99)).toBe(0.99);
  });
});

describe('the step list', () => {
  it('is ordered smallest first, which is what the clamp reads its bounds from', () => {
    // `MIN_SCALE`/`MAX_SCALE` are the first and last entries, not a min() over
    // the array. Re-order the list and the clamp inverts: every value lands
    // outside the bounds and gets pinned to one end.
    expect([...UI_SCALES]).toEqual([...UI_SCALES].sort((a, b) => a - b));
  });

  it('offers normal as one of its steps', () => {
    // 1 is the default and the value the provider treats as "clear the
    // override"; a list without it cannot express the shipped size.
    expect(UI_SCALES).toContain(1);
  });
});
