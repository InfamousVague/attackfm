import { describe, expect, it } from 'vitest';
import type { SleepTimer } from './playback.tsx';
import { sleepsAtAnEnd } from './sleepTimer.ts';

/**
 * "Is this timer waiting for the clock, or for something to finish?"
 *
 * Four guards in the deck branch on the answer and they all do the SAME
 * thing with it: a timer waiting on an ending must abort the crossfade,
 * refuse the prefetch and hold the chapter break, because the whole point is
 * that nothing may start after this. A clock timer must do none of that -
 * the music carries on normally until the minutes run out.
 *
 * So both directions are real failures with a sound. Answering yes to a
 * dated timer kills the crossfade of every song for an hour before the timer
 * even fires; answering no to `end-of-chapter` lets the next chapter start
 * over the top of the one the reader meant to stop at.
 */

describe('sleepsAtAnEnd', () => {
  it('says yes to the two endings', () => {
    expect(sleepsAtAnEnd('end-of-track')).toBe(true);
    expect(sleepsAtAnEnd('end-of-chapter')).toBe(true);
  });

  it('says no to a timer set by the clock', () => {
    // The regression this exists to stop: a 30-minute timer is not an
    // ending, and treating it as one silences every crossfade until it runs
    // out - half an hour of hard cuts nobody asked for.
    expect(sleepsAtAnEnd({ at: Date.now() + 1_800_000, minutes: 30 })).toBe(false);
    expect(sleepsAtAnEnd({ at: 0, minutes: 0 })).toBe(false);
  });

  it('says no when no timer is set at all', () => {
    expect(sleepsAtAnEnd(null)).toBe(false);
  });

  it('holds the chapter arm separately from the track arm', () => {
    // Two modes, not one with an alias. "End of track" is eleven hours away
    // in a one-file audiobook, which is a night light rather than a sleep
    // timer - `end-of-chapter` is the whole reason the union has two words
    // in it, and losing that arm makes the setting silently do nothing.
    const both: SleepTimer[] = ['end-of-track', 'end-of-chapter'];
    expect(both.filter(sleepsAtAnEnd)).toHaveLength(2);
  });

  it('narrows the type, so the clock’s own code still sees the dated shape', () => {
    // The predicate signature is the point of writing it as one: this block
    // does not compile if the `else` stops narrowing to `{ at, minutes }`.
    const sleep = { at: 1_000, minutes: 5 } as SleepTimer;
    if (sleepsAtAnEnd(sleep)) {
      expect.unreachable('a dated timer is not an ending');
    } else {
      expect(sleep?.minutes).toBe(5);
    }
  });
});
