/**
 * Louder as you drive faster - the volume rise every car stereo does with its
 * own speed signal, done here with the phone's.
 *
 * Road, wind and engine noise climb with speed and mask the quiet parts of a
 * mix; the fix in cars is Speed Compensated Volume, a gentle boost that tracks
 * the speedometer. The phone has no speedometer but it has GPS, and the
 * Geolocation API hands back metres-per-second with every fix.
 *
 * ## Where the boost is applied
 *
 * NOT on the fader. The volume slider keeps meaning what it says, exactly as
 * volume levelling decided before this: the boost folds into the meter's
 * ReplayGain stage (`setTrackGain`), summed in dB with the levelling gain.
 * That stage glides every change (~150ms in the kit) and this module only
 * moves in half-dB steps a few times a minute, so the rise is never audible
 * as an event - the music is simply louder when you next notice it.
 *
 * ## The curve
 *
 * Nothing below 20 km/h: parked, or creeping through town, the cabin is quiet
 * and a boost would just be loud. From there the gain climbs linearly to its
 * ceiling at 110 km/h - motorway speed, where the noise floor has long since
 * flattened out. The ceiling is the strength setting: gentle 3 dB, standard
 * 6 dB, strong 9 dB, the same range car head units offer. The boost rides ON
 * TOP of a track whose levelling already used its headroom, so a hot master
 * can clip at strong - which is why strong is a choice and not the default.
 *
 * ## GPS is a liar in small ways
 *
 * Fixes wobble, so raw speed is smoothed (EMA) before it picks a gain, and
 * the gain quantises to half-dB steps so subscribers re-render a few times a
 * minute, not per fix. A tunnel or an urban canyon stops the fixes entirely:
 * the last gain HOLDS for a grace period (a tunnel is the loudest road there
 * is), then decays to nothing - a permission revoked mid-drive lands in the
 * same place. Watching starts only while the setting is on; off means no GPS
 * use at all, which is the whole reason the switch defaults to off.
 */

import { useSyncExternalStore } from 'react';

export type DriveBoost = 'off' | 'gentle' | 'standard' | 'strong';

export const DRIVE_BOOSTS: readonly DriveBoost[] = ['off', 'gentle', 'standard', 'strong'];

/** The ceiling per strength, in dB. */
const CEILING_DB: Record<Exclude<DriveBoost, 'off'>, number> = {
  gentle: 3,
  standard: 6,
  strong: 9,
};

/** No boost below here (m/s): ~20 km/h. */
const FLOOR_MS = 5.5;
/** Full boost from here (m/s): ~110 km/h. */
const CEIL_MS = 30.5;

/** Without a fresh fix, the last gain stands this long, then lets go. A
 *  tunnel kills GPS and is the loudest stretch of any drive - dropping the
 *  boost at its mouth would be exactly backwards. */
const HOLD_MS = 90_000;

/** Smoothing: how much of each new fix enters the running speed. */
const ALPHA = 0.35;

/**
 * The curve, alone and pure so it can be tested without a car.
 * Half-dB steps: small enough to be inaudible on a glided stage, coarse
 * enough that a wobbling fix does not churn subscribers.
 */
export function boostFor(speedMs: number | null, strength: DriveBoost): number {
  if (strength === 'off' || speedMs === null || !Number.isFinite(speedMs)) return 0;
  const max = CEILING_DB[strength];
  const k = (speedMs - FLOOR_MS) / (CEIL_MS - FLOOR_MS);
  const db = max * Math.min(1, Math.max(0, k));
  return Math.round(db * 2) / 2;
}

let current = 0;
let smoothed: number | null = null;
let lastFixAt = 0;
let watchId: number | null = null;
let decayTimer = 0;
let strengthNow: DriveBoost = 'off';
const listeners = new Set<() => void>();

function publish(db: number): void {
  if (db === current) return;
  current = db;
  for (const fn of listeners) fn();
}

function onFix(pos: GeolocationPosition): void {
  const speed = pos.coords.speed;
  // A fix with no speed (stationary indoors, some desktop stacks) teaches
  // nothing; the hold-then-decay below handles the silence.
  if (speed === null || !Number.isFinite(speed) || speed < 0) return;
  lastFixAt = Date.now();
  smoothed = smoothed === null ? speed : smoothed + ALPHA * (speed - smoothed);
  publish(boostFor(smoothed, strengthNow));
}

/** The watchdog: no fix for the grace period means the boost lets go. */
function armDecay(): void {
  window.clearInterval(decayTimer);
  decayTimer = window.setInterval(() => {
    if (current !== 0 && Date.now() - lastFixAt > HOLD_MS) {
      smoothed = null;
      publish(0);
    }
  }, 15_000);
}

/**
 * Point the module at the current strength. Off tears the GPS watch down
 * entirely - the location indicator must never glow for a feature that is
 * switched off.
 */
export function setDriveBoostStrength(strength: DriveBoost): void {
  strengthNow = strength;
  if (strength === 'off') {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    window.clearInterval(decayTimer);
    watchId = null;
    smoothed = null;
    publish(0);
    return;
  }
  // Re-rate the standing speed under the new ceiling right away.
  publish(boostFor(smoothed, strength));
  if (watchId !== null || !navigator.geolocation) return;
  watchId = navigator.geolocation.watchPosition(onFix, () => {
    // Denied or unavailable: nothing to do but not boost. The pane's copy
    // told the listener a permission prompt was coming; a refusal is an
    // answer, not an error.
  }, {
    // Speed needs the real receiver; cell-tower fixes guess it from jumps.
    enableHighAccuracy: true,
    maximumAge: 5_000,
    timeout: 30_000,
  });
  armDecay();
}

/** The live boost in dB, for the Player to fold into the levelling stage. */
export function useDriveBoost(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
    () => 0,
  );
}
