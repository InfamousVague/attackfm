import { describe, expect, it } from 'vitest';
import {
  settleVelocity,
  SPOOL_RATE,
  SPOOL_SETTLED,
  targetVelocity,
  type MotorRamps,
} from './discMotor.ts';

/**
 * The motor under the platter.
 *
 * These are the promises the ticket "spin CD faster on buffer" is made of,
 * held as numbers rather than as an impression of a disc: a spool is several
 * times playing speed, not slightly more; it gets there quickly; it comes
 * back down by easing, never by snapping and never by reversing; reduced
 * motion never asks for a fast spin; and the pause style's brake still means
 * what it says when a spool ends on a pause.
 *
 * Frames are simulated at 60fps. The number that matters in every ramp is
 * "how many seconds", so the helpers count frames and report time.
 */

const FRAME = 1 / 60;
/** The deck's turntable ramps - the longest pause style, so the slowest brake. */
const TURNTABLE: MotorRamps = { spinUpMs: 380, spinDownMs: 320 };
/** The cut: a pause is a dead stop, a play is a snap to speed. */
const CUT: MotorRamps = { spinUpMs: 0, spinDownMs: 0 };

/** Run the motor from `from` toward `target` until it arrives (or `limit`
 *  seconds pass), returning every velocity it passed through. */
function run(from: number, target: number, ramps: MotorRamps, limit = 5): number[] {
  const path = [from];
  let v = from;
  for (let t = 0; t < limit && v !== target; t += FRAME) {
    v = settleVelocity(v, target, FRAME, ramps);
    path.push(v);
  }
  return path;
}

const seconds = (path: number[]) => (path.length - 1) * FRAME;

describe('targetVelocity', () => {
  it('asks for several times playing speed while spooling', () => {
    // "Slightly faster" was the bug. Four times is the floor for a spin that
    // reads as a seek; six is where the brief stops. The exact number is a
    // taste call inside that band, and this pins the band.
    expect(SPOOL_RATE).toBeGreaterThanOrEqual(4);
    expect(SPOOL_RATE).toBeLessThanOrEqual(6);
    expect(targetVelocity({ spinning: true, spooling: true, reducedMotion: false })).toBe(SPOOL_RATE);
  });

  it('spools whether or not sound has started', () => {
    // A download placeholder has no sound yet and spools anyway; the disc
    // says the machine is working before there is anything to play.
    expect(targetVelocity({ spinning: false, spooling: true, reducedMotion: false })).toBe(SPOOL_RATE);
  });

  it('is playing speed when sound is out and nothing is loading', () => {
    expect(targetVelocity({ spinning: true, spooling: false, reducedMotion: false })).toBe(1);
  });

  it('is a standstill when there is nothing to do', () => {
    expect(targetVelocity({ spinning: false, spooling: false, reducedMotion: false })).toBe(0);
  });

  it('never asks for a fast spin under reduced motion', () => {
    // Stillness outranks the spool AND the song: the disc under reduced
    // motion holds its face, which is what it did before the spool existed.
    expect(targetVelocity({ spinning: true, spooling: true, reducedMotion: true })).toBe(0);
    expect(targetVelocity({ spinning: true, spooling: false, reducedMotion: true })).toBe(0);
    expect(targetVelocity({ spinning: false, spooling: true, reducedMotion: true })).toBe(0);
  });
});

describe('settleVelocity: spooling up', () => {
  it('reaches the spool rate from playing speed in well under a second', () => {
    const path = run(1, SPOOL_RATE, TURNTABLE);
    expect(path.at(-1)).toBe(SPOOL_RATE);
    expect(seconds(path)).toBeLessThan(0.8);
    // And not instantly: a ramp is seen, a switch is not.
    expect(seconds(path)).toBeGreaterThan(0.3);
  });

  it('uses its own ramp, not the pause style\'s', () => {
    // The cut snaps to PLAYING speed on play; a spool is still a spin-up
    // from wherever the platter is, whichever pause style is set.
    const fromCut = run(1, SPOOL_RATE, CUT);
    const fromTurntable = run(1, SPOOL_RATE, TURNTABLE);
    expect(fromCut).toEqual(fromTurntable);
    expect(seconds(fromCut)).toBeGreaterThan(0.3);
  });

  it('climbs monotonically and never overshoots', () => {
    const path = run(0, SPOOL_RATE, TURNTABLE);
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!).toBeGreaterThanOrEqual(path[i - 1]!);
      expect(path[i]!).toBeLessThanOrEqual(SPOOL_RATE);
    }
  });

  it('still takes the deck\'s ramp from a standstill to playing speed', () => {
    // The spool's quick ramp must not have leaked into an ordinary play:
    // 0 -> 1 over spinUpMs is the deck's promise, matched to its audio ramp.
    const path = run(0, 1, TURNTABLE);
    expect(seconds(path)).toBeCloseTo(0.38, 1);
    expect(run(0, 1, CUT)).toEqual([0, 1]);
  });
});

describe('settleVelocity: the spool ending while the song plays', () => {
  const path = run(SPOOL_RATE, 1, TURNTABLE);

  it('lands exactly on playing speed', () => {
    expect(path.at(-1)).toBe(1);
  });

  it('eases rather than snapping: the first frame takes a small bite', () => {
    // A snap would be one frame; a linear drop would be a constant bite. A
    // coast's first frame is the biggest and still a small share of the gap.
    const bite = (path[0]! - path[1]!) / (SPOOL_RATE - 1);
    expect(bite).toBeGreaterThan(0);
    expect(bite).toBeLessThan(0.1);
  });

  it('slows its descent as it nears playing speed', () => {
    // The shape of a coast: each frame's drop is smaller than the last.
    for (let i = 2; i < path.length - 1; i++) {
      const before = path[i - 2]! - path[i - 1]!;
      const after = path[i - 1]! - path[i]!;
      expect(after).toBeLessThanOrEqual(before);
    }
  });

  it('never dips below playing speed and never reverses', () => {
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!).toBeGreaterThanOrEqual(1);
      expect(path[i]!).toBeLessThanOrEqual(path[i - 1]!);
    }
  });

  it('is at speed within two seconds', () => {
    expect(seconds(path)).toBeLessThan(2);
    // And it is a visible run-down, not a cut disguised as one.
    expect(seconds(path)).toBeGreaterThan(0.5);
  });

  it('treats a few percent over as arrived, so it cannot coast for ever', () => {
    expect(settleVelocity(1 + SPOOL_SETTLED / 2, 1, FRAME, TURNTABLE)).toBe(1);
  });

  it('is the same coast whichever pause style is set', () => {
    // The brake belongs to a pause; a spool ending on a playing song never
    // touches it. So the cut - a dead stop on pause - does not snap here.
    expect(run(SPOOL_RATE, 1, CUT)).toEqual(path);
  });
});

describe('settleVelocity: the spool ending on a pause', () => {
  it('keeps the cut\'s promise of a dead stop', () => {
    expect(run(SPOOL_RATE, 0, CUT)).toEqual([SPOOL_RATE, 0]);
  });

  it('coasts, then brakes to a standstill under the turntable', () => {
    const path = run(SPOOL_RATE, 0, TURNTABLE);
    expect(path.at(-1)).toBe(0);
    for (let i = 1; i < path.length; i++) {
      expect(path[i]!).toBeGreaterThanOrEqual(0);
      expect(path[i]!).toBeLessThanOrEqual(path[i - 1]!);
    }
    // Longer than a plain pause from playing speed - it started five times
    // faster - but not five times longer: friction does most of the work.
    expect(seconds(path)).toBeGreaterThan(0.32);
    expect(seconds(path)).toBeLessThan(2);
  });

  it('is the deck\'s own brake from playing speed', () => {
    // Below playing speed friction has no say; the brake alone runs the
    // platter down, over spinDownMs, as it always did.
    const path = run(1, 0, TURNTABLE);
    expect(seconds(path)).toBeCloseTo(0.32, 1);
  });
});

describe('settleVelocity: at rest', () => {
  it('holds a velocity that is already at its target', () => {
    expect(settleVelocity(1, 1, FRAME, TURNTABLE)).toBe(1);
    expect(settleVelocity(SPOOL_RATE, SPOOL_RATE, FRAME, TURNTABLE)).toBe(SPOOL_RATE);
    expect(settleVelocity(0, 0, FRAME, TURNTABLE)).toBe(0);
  });

  it('does nothing in no time', () => {
    expect(settleVelocity(1, SPOOL_RATE, 0, TURNTABLE)).toBe(1);
    expect(settleVelocity(SPOOL_RATE, 1, 0, TURNTABLE)).toBe(SPOOL_RATE);
  });
});
