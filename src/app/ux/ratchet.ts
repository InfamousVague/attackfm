import { fireMicroTick, fireNativeHaptic } from '../core/haptics.ts';

/**
 * The run-up to a detent, felt.
 *
 * A single tick when a gesture crosses its line is a fact, not a feeling: it
 * reports where the line WAS, after the finger went past it. A dial tells you
 * a stop is coming - its notches tighten as it nears one - and that is what a
 * drag with a threshold in it wants too, because the hand is already moving
 * and the decision is made before the eye catches up.
 *
 * So the approach is ticked: softly and far apart at first, closer and firmer
 * as it arrives, and the threshold itself lands properly.
 *
 * Lives here rather than in either caller because there are two gestures with
 * exactly this shape - the pull from the top of a page, and pushing the Now
 * Playing sheet back down - and a tick pattern that drifts between them is a
 * phone that feels like two different apps depending on which way you drag.
 */

/** Notch spacing at the start of a run-up, and at the end of it. */
const NOTCH_FAR = 24;
const NOTCH_NEAR = 9;
/**
 * No two ticks closer together than this, however fast the finger moves. The
 * Taptic Engine will happily queue a flood and then play it back as mush.
 */
const TICK_FLOOR_MS = 28;

/** What a notch is worth, given how far into the run-up it falls. */
export function notchWeight(p: number): 'micro' | 'selection' | 'light' {
  if (p < 0.45) return 'micro';
  if (p < 0.8) return 'selection';
  return 'light';
}

/** How far apart notches are, given the same. */
export function notchSpacing(p: number): number {
  return NOTCH_FAR - (NOTCH_FAR - NOTCH_NEAR) * Math.min(1, Math.max(0, p));
}

/**
 * Whether this travel has reached the next notch - and what it is worth.
 *
 * Pure, so the pattern can be checked without a Taptic Engine to feel it: the
 * haptics themselves are native-only and silently inert everywhere a test can
 * run, which would otherwise make this the one part of a gesture nobody could
 * verify.
 */
export function nextNotch(
  travel: number,
  from: number,
  to: number,
  since: number,
): 'micro' | 'selection' | 'light' | null {
  if (travel <= from || to <= from) return null;
  const p = Math.min(1, (travel - from) / (to - from));
  if (travel - since < notchSpacing(p)) return null;
  return notchWeight(p);
}

export interface Ratchet {
  /** Feed the live travel; ticks when it crosses a notch. */
  feel: (travel: number, from: number, to: number, nowMs: number) => void;
  /** The threshold itself, once per gesture. */
  arrive: (weight?: 'medium' | 'heavy') => void;
  /** New gesture, clean slate. */
  reset: () => void;
}

export function makeRatchet(): Ratchet {
  let sinceTravel = 0;
  let sinceMs = 0;
  let arrived = false;
  return {
    feel(travel, from, to, nowMs) {
      if (nowMs - sinceMs < TICK_FLOOR_MS) return;
      const kind = nextNotch(travel, from, to, sinceTravel);
      if (!kind) return;
      sinceTravel = travel;
      sinceMs = nowMs;
      if (kind === 'micro') fireMicroTick();
      else fireNativeHaptic(kind);
    },
    arrive(weight = 'medium') {
      if (arrived) return;
      arrived = true;
      fireNativeHaptic(weight);
    },
    reset() {
      sinceTravel = 0;
      sinceMs = 0;
      arrived = false;
    },
  };
}
