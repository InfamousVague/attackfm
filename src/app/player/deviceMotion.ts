/**
 * The phone's own movement, as something the player can listen to.
 *
 * No native plugin: DeviceMotionEvent and DeviceOrientationEvent are web APIs
 * and the app is a webview, so this is the one piece of hardware the frontend
 * can reach on its own. iOS wants permission asked from inside a user gesture
 * (see `askMotionAccess`); Android grants it on a secure origin, which
 * tauri.localhost is.
 *
 * Two different things come out of the same sensor and they are kept apart on
 * purpose:
 *
 *   TILT is orientation - where the phone is pointing - and it is continuous,
 *   smoothed, and only ever used to move something a few pixels. It comes off
 *   deviceorientation, which is already filtered by the OS.
 *
 *   GESTURES are acceleration - how hard the phone was just moved - and they
 *   are discrete, thresholded events. They come off devicemotion, unfiltered,
 *   because the sharpness IS the signal.
 *
 * Nothing here listens until something asks. A player that holds a sensor open
 * while it is not on screen is paying for a reading nobody reads.
 */

/** Orientation, normalised to roughly -1..1 and rested at 0. */
export interface Tilt {
  /** Left/right roll. Negative is tipped left. */
  x: number;
  /** Front/back pitch. Negative is tipped away from you. */
  y: number;
}

export type MotionGesture = 'shake' | 'flick-left' | 'flick-right';

/**
 * How far the phone has to be tipped to reach the ends of the range.
 *
 * 22 degrees, not 90: this drives a parallax of a few pixels, and a range that
 * needs the phone turned on its side to reach the end of would read as broken
 * rather than subtle. A hand at rest wanders by a couple of degrees, so the
 * useful signal is all in the first twenty.
 */
const TILT_RANGE_DEG = 22;

/** Below this the reading is hand-tremor and is treated as level. */
const TILT_DEADZONE = 0.04;

/**
 * How much of the previous reading survives each new one.
 *
 * deviceorientation arrives around 60Hz and is noisy enough that raw values
 * make anything bound to them jitter visibly. High smoothing is affordable
 * because nothing here needs to be responsive - it needs to feel like weight.
 */
const TILT_SMOOTHING = 0.85;

/** m/s^2 above gravity that counts as a real movement rather than carrying. */
const SHAKE_THRESHOLD = 14;

/**
 * How many direction reversals inside SHAKE_WINDOW make a shake.
 *
 * The window is the discriminating half, not the count. Walking reverses too -
 * it is a 2Hz rhythm - so a count alone says "shake" every time somebody
 * carries the phone down a corridor, which is what the first version of this
 * did. Three reversals inside 450ms is above 6Hz, which is a wrist, not a gait.
 */
const SHAKE_REVERSALS = 3;
const SHAKE_WINDOW_MS = 450;

/** A flick is sharper than a shake and happens on one axis. */
const FLICK_THRESHOLD = 12;

/**
 * How quiet it has to have been just before a spike for that spike to count.
 *
 * This is what separates a flick from walking, and it is the whole reason
 * flick-to-skip is shippable. Walking is not quiet: it is a continuous 2Hz
 * rhythm, so any large lateral reading has other large readings on both sides
 * of it. A flick from a hand at rest has a silent lead-in. Requiring the
 * previous QUIET_LEAD_MS to stay under QUIET_CEILING rejects the walking case
 * without needing to recognise walking.
 */
const QUIET_LEAD_MS = 350;
const QUIET_CEILING = 4;

/** Nothing else fires for this long after a gesture lands. */
const COOLDOWN_MS = 900;

/**
 * How long a flick waits to see whether it was the first half of a shake.
 *
 * A shake BEGINS with a hard sideways movement out of a still hand, which is
 * the flick signature exactly - so firing a flick the moment it is recognised
 * means every shake skips a track before it shuffles. There is no threshold
 * that separates them, because at the first sample they are the same event;
 * the difference is entirely in what happens NEXT.
 *
 * So a flick is held and confirmed only if no shake develops. 260ms because a
 * shake needs three reversals inside 450ms and a brisk one delivers them in
 * about 210 - the confirmation has to outlast that or it decides too early.
 * The cost is 260ms of latency on skip, which is under the threshold where a
 * deliberate gesture feels unacknowledged.
 */
const FLICK_CONFIRM_MS = 260;

type Listener = (g: MotionGesture) => void;

const gestureListeners = new Set<Listener>();
const tiltListeners = new Set<(t: Tilt) => void>();

let motionBound = false;
let orientationBound = false;
let tilt: Tilt = { x: 0, y: 0 };

/** Recent acceleration magnitudes, for the quiet-lead test. */
let recent: { t: number; mag: number; x: number }[] = [];
let lastGestureAt = 0;
let reversals = 0;
let reversalStart = 0;
let lastSign = 0;
/** Whether the current reversal run began from a hand at rest. */
let runFromRest = false;
/** A flick recognised but not yet confirmed - see FLICK_CONFIRM_MS. */
let pending: { dir: MotionGesture; at: number } | null = null;
let pendingTimer: ReturnType<typeof setTimeout> | null = null;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function cancelPending(): void {
  pending = null;
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer);
    pendingTimer = null;
  }
}

function emit(g: MotionGesture): void {
  cancelPending();
  lastGestureAt = performance.now();
  // A gesture consumes the history that produced it, so one hard movement
  // cannot satisfy the next gesture's window as well.
  recent = [];
  reversals = 0;
  runFromRest = false;
  for (const l of gestureListeners) l(g);
}

function onOrientation(e: DeviceOrientationEvent): void {
  // gamma is roll, beta is pitch. Either can be null on a device that only
  // reports some axes, and null is level rather than zero-ish garbage.
  const roll = typeof e.gamma === 'number' ? e.gamma : 0;
  const pitch = typeof e.beta === 'number' ? e.beta : 0;
  const nx = clamp(roll / TILT_RANGE_DEG, -1, 1);
  const ny = clamp((pitch - 45) / TILT_RANGE_DEG, -1, 1);
  const x = tilt.x * TILT_SMOOTHING + nx * (1 - TILT_SMOOTHING);
  const y = tilt.y * TILT_SMOOTHING + ny * (1 - TILT_SMOOTHING);
  tilt = {
    x: Math.abs(x) < TILT_DEADZONE ? 0 : x,
    y: Math.abs(y) < TILT_DEADZONE ? 0 : y,
  };
  for (const l of tiltListeners) l(tilt);
}

/**
 * Was the phone still just before now?
 *
 * The single most useful thing to know about a spike, and what makes both of
 * these gestures shippable. Walking, running and a pocket are all CONTINUOUS -
 * any big reading has other big readings on either side of it. A deliberate
 * movement starts from a hand that was holding still. Testing for the quiet
 * lead-in rejects the whole family of carried-phone false positives without
 * having to recognise any of them.
 */
function cameFromRest(now: number): boolean {
  const lead = recent.filter((r) => r.t < now - 60 && r.t > now - 60 - QUIET_LEAD_MS);
  // Too few samples means the listener only just started: not proven, rather
  // than quiet. Otherwise the first reading after mounting can fire a gesture.
  return lead.length >= 3 && lead.every((r) => r.mag < QUIET_CEILING);
}

function onMotion(e: DeviceMotionEvent): void {
  const a = e.acceleration ?? e.accelerationIncludingGravity;
  if (!a) return;
  const x = a.x ?? 0;
  const y = a.y ?? 0;
  const z = a.z ?? 0;
  // accelerationIncludingGravity carries a constant ~9.8; subtracting the
  // vector's resting length is close enough for a threshold test and avoids
  // caring which of the two properties the device actually gave us.
  const raw = Math.hypot(x, y, z);
  const mag = e.acceleration ? raw : Math.abs(raw - 9.81);
  const now = performance.now();

  // A held flick confirms here rather than on a timer, because devicemotion
  // keeps arriving at a steady rate whether or not the phone is moving, so the
  // next sample is always close behind. The timer in `holdFlick` is only a
  // backstop for a device that stops reporting entirely.
  if (pending && now - pending.at >= FLICK_CONFIRM_MS) {
    const dir = pending.dir;
    emit(dir);
    return;
  }

  recent.push({ t: now, mag, x });
  const cutoff = now - Math.max(SHAKE_WINDOW_MS, QUIET_LEAD_MS) - 50;
  while (recent.length > 0 && recent[0]!.t < cutoff) recent.shift();

  if (now - lastGestureAt < COOLDOWN_MS) return;

  // ---- shake: several reversals in a short window ------------------------
  if (mag > SHAKE_THRESHOLD) {
    const sign = Math.sign(x);
    if (sign !== 0 && sign !== lastSign) {
      if (reversals === 0 || now - reversalStart > SHAKE_WINDOW_MS) {
        // A new run. Whether it started from rest is decided HERE and carried,
        // because by the third reversal the shake itself is the recent history
        // and asking then would always answer "no".
        reversals = 1;
        reversalStart = now;
        runFromRest = cameFromRest(now);
      } else {
        reversals += 1;
      }
      lastSign = sign;
    }
    if (runFromRest && reversals >= SHAKE_REVERSALS && now - reversalStart <= SHAKE_WINDOW_MS) {
      // Beats any flick still being held: this movement was a shake all along.
      emit('shake');
      return;
    }
  }

  // ---- flick: one sharp sideways spike out of quiet -----------------------
  if (Math.abs(x) > FLICK_THRESHOLD && Math.abs(x) > Math.abs(y) && Math.abs(x) > Math.abs(z)) {
    if (!pending && cameFromRest(now)) {
      // Device x points right, so a flick to the RIGHT accelerates the phone
      // in +x and the gesture reads as "next".
      holdFlick(x > 0 ? 'flick-right' : 'flick-left', now);
    }
  }
}

function holdFlick(dir: MotionGesture, now: number): void {
  pending = { dir, at: now };
  pendingTimer = setTimeout(() => {
    pendingTimer = null;
    if (pending) emit(pending.dir);
  }, FLICK_CONFIRM_MS + 40);
}

function bindMotion(): void {
  if (motionBound || typeof window === 'undefined') return;
  window.addEventListener('devicemotion', onMotion);
  motionBound = true;
}

function unbindMotion(): void {
  if (!motionBound) return;
  window.removeEventListener('devicemotion', onMotion);
  motionBound = false;
  recent = [];
  reversals = 0;
  cancelPending();
}

function bindOrientation(): void {
  if (orientationBound || typeof window === 'undefined') return;
  window.addEventListener('deviceorientation', onOrientation);
  orientationBound = true;
}

function unbindOrientation(): void {
  if (!orientationBound) return;
  window.removeEventListener('deviceorientation', onOrientation);
  orientationBound = false;
  tilt = { x: 0, y: 0 };
  for (const l of tiltListeners) l(tilt);
}

/** Listen for shakes and flicks. Returns the unsubscribe. */
export function subscribeGestures(fn: Listener): () => void {
  gestureListeners.add(fn);
  bindMotion();
  return () => {
    gestureListeners.delete(fn);
    if (gestureListeners.size === 0) unbindMotion();
  };
}

/** Listen for tilt. Returns the unsubscribe. */
export function subscribeTilt(fn: (t: Tilt) => void): () => void {
  tiltListeners.add(fn);
  bindOrientation();
  fn(tilt);
  return () => {
    tiltListeners.delete(fn);
    if (tiltListeners.size === 0) unbindOrientation();
  };
}

/**
 * Whether this device reports motion at all.
 *
 * Presence of the constructor is not the same as a sensor answering - a desktop
 * browser has both interfaces and no hardware - so anything user-facing should
 * treat this as "worth trying", not as "this works".
 */
export function motionAvailable(): boolean {
  return typeof window !== 'undefined' && 'DeviceMotionEvent' in window;
}

interface PermissionCapable {
  requestPermission?: () => Promise<'granted' | 'denied' | 'default'>;
}

/**
 * Ask iOS for motion access. MUST be called from inside a real user gesture.
 *
 * Android and desktop have no such prompt and resolve true without asking, so
 * callers can await this unconditionally rather than branching on platform.
 */
export async function askMotionAccess(): Promise<boolean> {
  if (typeof window === 'undefined' || !('DeviceMotionEvent' in window)) return false;
  const ctor = window.DeviceMotionEvent as unknown as PermissionCapable;
  if (typeof ctor.requestPermission !== 'function') return true;
  try {
    return (await ctor.requestPermission()) === 'granted';
  } catch {
    // Called outside a gesture, or refused at the OS level.
    return false;
  }
}
