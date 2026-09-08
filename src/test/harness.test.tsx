/**
 * The harness proving itself.
 *
 * This file is not a test suite for `format.ts` - Agent E owns that, beside
 * the module, and should write it without reference to this. What is here is
 * the smallest thing that can fail if any part of the plumbing is wrong:
 * TypeScript resolving a `.ts` extension import out of `src/`, Vite's
 * transform, the jsdom window, the Testing Library render, the jest-dom
 * matchers, and the setup file's cleanup. If this file is green, a suite
 * author can assume the tools work and go and think about the module instead.
 *
 * It also demonstrates the house rule the suites are written under, from
 * `attackfm-verify-via-vite-import`: A TEST THAT PASSES PROVES NOTHING UNTIL
 * YOU HAVE WATCHED IT FAIL. The three `formatClock` cases below are arranged
 * so that each one dies if a specific line of production code is removed -
 * the floor, the pad, and the finite-check - rather than all three passing on
 * the strength of one of them.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { formatClock } from '../app/ux/format.ts';

describe('formatClock - the harness can see production logic', () => {
  /**
   * FLOOR, NOT ROUND. `format.ts` says one of the five hand-rolled copies
   * this replaced could print "1:60"; that is what rounding inside the
   * seconds does. Swap `Math.floor` for `Math.round` and this case - and only
   * this case - fails.
   */
  it('floors the seconds so a clock never shows a second that has not happened', () => {
    expect(formatClock(59.9)).toBe('0:59');
    expect(formatClock(0.99)).toBe('0:00');
  });

  /**
   * The pad is the other half of a fixed-width clock. `padStart(2, '0')`
   * removed leaves "1:1", which no seek bar has ever printed.
   */
  it('pads the seconds to two digits', () => {
    expect(formatClock(61)).toBe('1:01');
    expect(formatClock(3599)).toBe('59:59');
  });

  /**
   * THE THIRD CASE IS THE ONE THAT MAKES THE OTHER TWO MEAN SOMETHING.
   *
   * A deck reports `Infinity` on a transcode stream and `NaN` before metadata
   * lands, and the guard turns both into the placeholder. Asserting only that
   * is a trap: `formatClock = () => placeholder` would satisfy it completely.
   * So the same case asserts the guard LETS GO - a finite duration comes back
   * formatted, and a caller-supplied placeholder is used instead of the
   * default. Delete the `Number.isFinite` check and the first half fails;
   * widen it to everything and the second half fails.
   */
  it('returns the placeholder only while the duration is unknown', () => {
    expect(formatClock(Infinity)).toBe('0:00');
    expect(formatClock(NaN)).toBe('0:00');
    expect(formatClock(null)).toBe('0:00');
    expect(formatClock(undefined, '--:--')).toBe('--:--');

    // ...and the guard is a guard, not the whole function.
    expect(formatClock(90, '--:--')).toBe('1:30');
  });
});

describe('the DOM half of the harness', () => {
  it('renders into jsdom and answers a jest-dom matcher', () => {
    render(
      <button type="button" aria-label="Play">
        {formatClock(184)}
      </button>,
    );

    const play = screen.getByRole('button', { name: 'Play' });
    expect(play).toBeInTheDocument();
    expect(play).toHaveTextContent('3:04');
  });

  it('starts each test with an empty document and an empty localStorage', () => {
    // Nothing from the render above survived: `cleanup()` in `src/test/setup.ts`
    // unmounted it. Without that line this query finds the previous button and
    // the assertion below fails - which is the whole point of asserting it.
    expect(screen.queryByRole('button')).toBeNull();
    expect(localStorage.length).toBe(0);
  });
});
