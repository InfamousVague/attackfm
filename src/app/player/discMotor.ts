/**
 * The motor under the platter, as numbers.
 *
 * SpinningDisc integrates an angle at frame rate, and the one thing that
 * decides how the disc LOOKS is the velocity it integrates: what speed it is
 * asked for, and how it gets from the speed it has to the speed it wants.
 * Both of those used to live inline in the animation loop, where the only way
 * to check them was to watch a disc. They live here instead, with no React
 * and no clock around them, so "the spool is unmistakably faster than
 * playing" and "the spool eases off rather than snapping" are things a test
 * can hold the numbers to.
 *
 * Velocity throughout is a share of playing speed: 1 is the platter turning
 * as the song does, 0 is a standstill, and a spool runs it above 1. The disc
 * turns that share into degrees.
 */

/**
 * How fast the platter runs while the track is still loading, as a multiple
 * of playing speed. A real drive spins up hard while it seeks - long before
 * the head reads anything - and that whirr is the machine telling you it is
 * working, which is exactly what a buffering strip has to say and usually
 * says with a spinner nobody reads.
 *
 * Five times, not the "just under three" this started at: at 2.8x the disc
 * read as slightly hurried, which nobody took for a seek. At five the print
 * blurs into a ring, and that blur IS the message - a seeking drive does not
 * keep its label legible.
 */
export const SPOOL_RATE = 5;

/**
 * Milliseconds per unit of velocity on the way up - so playing speed to full
 * spool takes a little over half a second: quick enough to be a spin-up, long
 * enough to be seen ramping rather than switching.
 */
export const SPOOL_UP_MS = 150;

/**
 * The way back down is not a ramp: the motor stops driving and the platter
 * coasts, losing a constant SHARE of its excess speed per unit time - the
 * way real friction takes a real platter. Steep at first, gentle at the end,
 * settling onto playing speed rather than hitting it. This is the time
 * constant; five times speed is within a few percent of playing speed after
 * about a second and a half.
 */
export const SPOOL_TAU = 0.3;

/**
 * Close enough to playing speed to call it there. A coast approaches 1x
 * without ever reaching it, and a platter that is 3% fast is a platter at
 * speed to any eye.
 */
export const SPOOL_SETTLED = 0.03;

export interface MotorState {
  /** Sound is actually coming out. */
  spinning: boolean;
  /** The track is still loading. Outranks `spinning`: the disc spools while
   *  the bytes are coming whether or not sound has started. */
  spooling: boolean;
  /** The OS asked for stillness. Outranks everything. */
  reducedMotion: boolean;
}

/** The ramps the deck hands the disc: how long the platter takes from a
 *  standstill to playing speed, and from playing speed to a standstill. */
export interface MotorRamps {
  spinUpMs: number;
  spinDownMs: number;
}

/**
 * The speed the platter is being asked for, as a share of playing speed.
 * Reduced motion is a standstill whatever else is true: the disc holds its
 * face, and no fast spin is ever asked of it.
 */
export function targetVelocity({ spinning, spooling, reducedMotion }: MotorState): number {
  if (reducedMotion) return 0;
  if (spooling) return SPOOL_RATE;
  return spinning ? 1 : 0;
}

/**
 * One frame of the motor: where `velocity` gets to, `dt` seconds later, on
 * its way to `target`.
 *
 * Going up is linear - constant torque - and a spool (any target above
 * playing speed) has its own, quicker ramp than the deck's play-from-a-
 * standstill one. Coming down is a question of which force has the platter,
 * and it follows whichever has it lower:
 *
 * - Friction, which acts only above playing speed and only ever coasts the
 *   excess off toward 1x. It cannot overshoot and cannot reverse, and it is
 *   the whole story of a spool that ends while the song plays on.
 * - The brake, which the pause style bought and which acts only when the
 *   target is a standstill: the same linear run-down the deck's audio takes.
 *   A spool that ends because the listener pressed pause coasts until the
 *   brake catches it, and a pause style that promised a dead stop still
 *   gets one - a zero-length brake snaps from any speed.
 */
export function settleVelocity(
  velocity: number,
  target: number,
  dt: number,
  { spinUpMs, spinDownMs }: MotorRamps,
): number {
  if (velocity < target) {
    // Anything above playing speed is a spool, and a spool has its own ramp.
    const ms = target > 1 ? SPOOL_UP_MS : spinUpMs;
    return ms <= 0 ? target : Math.min(target, velocity + (dt * 1000) / ms);
  }
  if (velocity > target) {
    let v = velocity;
    if (v > 1) {
      v = 1 + (v - 1) * Math.exp(-dt / SPOOL_TAU);
      if (v - 1 < SPOOL_SETTLED) v = 1;
    }
    if (target < 1) {
      const brake = spinDownMs <= 0 ? target : Math.max(target, velocity - (dt * 1000) / spinDownMs);
      v = Math.min(v, brake);
    }
    return Math.max(target, v);
  }
  return velocity;
}
