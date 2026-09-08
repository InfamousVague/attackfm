/**
 * The run-up to a detent, as arithmetic.
 *
 * `nextNotch` carries its own reason for existing in its doc comment: "Pure, so
 * the pattern can be checked without a Taptic Engine to feel it: the haptics
 * themselves are native-only and silently inert everywhere a test can run,
 * which would otherwise make this the one part of a gesture nobody could
 * verify."
 *
 * Two gestures share it - the pull from the top of a page and pushing the Now
 * Playing sheet back down - and the whole point of the sharing is that "a tick
 * pattern that drifts between them is a phone that feels like two different
 * apps depending on which way you drag."
 */
import { describe, expect, it, vi } from 'vitest';

/** The haptics are native and inert here; spied so `makeRatchet`'s own rules -
 *  the time floor, and arrive-once - are observable rather than assumed. */
const fireMicroTick = vi.fn();
const fireNativeHaptic = vi.fn();
vi.mock('../core/haptics.ts', () => ({ fireMicroTick, fireNativeHaptic }));

const { makeRatchet, nextNotch, notchSpacing, notchWeight } = await import('./ratchet.ts');

describe('notchWeight', () => {
  it('firms up as the threshold approaches', () => {
    expect(notchWeight(0)).toBe('micro');
    expect(notchWeight(0.44)).toBe('micro');
    expect(notchWeight(0.45)).toBe('selection');
    expect(notchWeight(0.79)).toBe('selection');
    expect(notchWeight(0.8)).toBe('light');
    expect(notchWeight(1)).toBe('light');
  });
});

describe('notchSpacing', () => {
  it('tightens from far apart to close together', () => {
    // A dial tells you a stop is coming: its notches tighten as it nears one.
    expect(notchSpacing(0)).toBe(24);
    expect(notchSpacing(1)).toBe(9);
    expect(notchSpacing(0.5)).toBe(16.5);
  });

  it('is monotonic across the run-up', () => {
    let last = Infinity;
    for (let p = 0; p <= 1; p += 0.05) {
      const gap = notchSpacing(p);
      expect(gap).toBeLessThanOrEqual(last);
      last = gap;
    }
  });

  it('clamps outside the run-up rather than running away', () => {
    // p is a ratio, and a gesture can travel past its threshold.
    expect(notchSpacing(-5)).toBe(24);
    expect(notchSpacing(5)).toBe(9);
  });
});

describe('nextNotch', () => {
  it('says nothing before the run-up has begun', () => {
    expect(nextNotch(0, 20, 100, 0)).toBeNull();
    expect(nextNotch(20, 20, 100, 0)).toBeNull();
  });

  it('refuses a run-up with no length', () => {
    /*
     * A zero range divides by zero; an inverted one produces a negative ratio.
     * Both are asked with the travel PAST `from`, so the first clause cannot
     * answer for them - otherwise this would pass against a function with no
     * `to <= from` guard at all, which is what happens: the zero range gives
     * p = Infinity clamped to 1 and ticks 'light' on the first move, and the
     * inverted one gives a negative p and ticks 'micro'.
     */
    expect(nextNotch(150, 100, 100, 0)).toBeNull();
    expect(nextNotch(150, 100, 20, 0)).toBeNull();
  });

  it('ticks once the finger has moved a notch further', () => {
    // ~21 px apart this early in the run-up (24 at p=0, closing as p grows),
    // measured from where the last tick was rather than from `from`.
    expect(nextNotch(40, 20, 120, 20)).toBeNull();
    expect(nextNotch(45, 20, 120, 20)).toBe('micro');
  });

  it('needs LESS travel per tick nearer the threshold', () => {
    // The same 12 px of movement is not a notch at the start and is one at the
    // end - which is the entire feel this module exists to produce.
    expect(nextNotch(32, 20, 120, 20)).toBeNull();
    expect(nextNotch(112, 20, 120, 100)).toBe('light');
  });

  it('reports the weight for where the travel is now', () => {
    expect(nextNotch(60, 20, 120, 0)).toBe('micro');
    expect(nextNotch(80, 20, 120, 0)).toBe('selection');
    expect(nextNotch(120, 20, 120, 0)).toBe('light');
  });

  it('never runs past the end of the run-up', () => {
    // p is clamped to 1, so travel beyond the threshold is still 'light'.
    expect(nextNotch(400, 20, 120, 0)).toBe('light');
  });
});

describe('makeRatchet', () => {
  it('holds a floor between ticks, however fast the finger moves', () => {
    /*
     * "The Taptic Engine will happily queue a flood and then play it back as
     * mush." TICK_FLOOR_MS is 28.
     */
    const r = makeRatchet();
    r.feel(60, 20, 120, 1000);
    expect(fireMicroTick).toHaveBeenCalledTimes(1);
    r.feel(120, 20, 120, 1010);
    expect(fireNativeHaptic).not.toHaveBeenCalled();
    r.feel(120, 20, 120, 1040);
    expect(fireNativeHaptic).toHaveBeenCalledWith('light');
  });

  it('arrives exactly once per gesture', () => {
    // A threshold crossed and re-crossed by a wobbling finger is one arrival.
    const r = makeRatchet();
    r.arrive();
    r.arrive();
    r.arrive('heavy');
    expect(fireNativeHaptic).toHaveBeenCalledTimes(1);
    expect(fireNativeHaptic).toHaveBeenCalledWith('medium');
  });

  it('takes a heavier arrival when asked', () => {
    const r = makeRatchet();
    r.arrive('heavy');
    expect(fireNativeHaptic).toHaveBeenCalledWith('heavy');
  });

  it('starts clean after a reset', () => {
    const r = makeRatchet();
    r.feel(60, 20, 120, 1000);
    r.arrive();
    fireMicroTick.mockClear();
    fireNativeHaptic.mockClear();

    r.reset();
    // Same travel, same clock: after a reset it is a new gesture, so both the
    // notch memory and the arrival latch are gone.
    r.feel(60, 20, 120, 1000);
    r.arrive();
    expect(fireMicroTick).toHaveBeenCalledTimes(1);
    expect(fireNativeHaptic).toHaveBeenCalledTimes(1);
  });

  it('does not tick when the finger has not reached the next notch', () => {
    // A fresh ratchet measures from zero travel, so the run-up has to be past
    // a whole notch before the first tick - a nudge is not a notch.
    const r = makeRatchet();
    r.feel(18, 5, 120, 1000);
    r.feel(20, 5, 120, 2000);
    expect(fireMicroTick).not.toHaveBeenCalled();
    expect(fireNativeHaptic).not.toHaveBeenCalled();
  });
});
