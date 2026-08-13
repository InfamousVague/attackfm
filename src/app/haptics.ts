import { useSyncExternalStore } from 'react';
import type { HapticKind } from '@glacier/react';
import { isTauri } from './tauri.ts';
import { isMobile } from './platform.ts';

/**
 * The app's half of the kit's haptics system: a real Taptic Engine behind
 * GlacierUI's HapticsProvider, and the preference that turns it on.
 *
 * The kit ships web fallbacks (navigator.vibrate, the iOS <input switch>
 * trick), but neither reaches WKWebView - a Tauri iOS app that wants haptics
 * has to cross the bridge. tauri-plugin-haptics does, to UIFeedbackGenerator,
 * which is also simply BETTER than any web path: real intensity tiers, the
 * selection tick, the success/warning/error triplets.
 *
 * The native impl exists only on a phone build. On desktop the provider gets
 * no impl and stays a visual-bus-only no-op; on the web it keeps the kit's
 * fallbacks (which give Android Chrome its motor).
 */

/** In a Tauri build on a phone: the only place the plugin exists. */
const nativeHaptics = isTauri() && isMobile;

// Loaded lazily so desktop builds and the web preview never pull the plugin
// module at all; after the first call it is the resolved module.
let pluginPromise: Promise<typeof import('@tauri-apps/plugin-haptics')> | null = null;
function plugin() {
  pluginPromise ??= import('@tauri-apps/plugin-haptics');
  return pluginPromise;
}

/**
 * The kit's seven kinds, spoken in UIFeedbackGenerator's dialect. Impacts map
 * by weight; the three notification kinds are exactly what UINotification-
 * FeedbackGenerator was built to say.
 */
export function fireNativeHaptic(kind: HapticKind = 'light'): void {
  if (!nativeHaptics) return;
  // The provider gates its DELEGATED presses on `enabled`, but hands a custom
  // impl through useHaptics ungated - so the pref is enforced here, once, for
  // every path into the motor.
  if (!hapticsPref()) return;
  void plugin()
    .then((h) => {
      switch (kind) {
        case 'selection':
          return h.selectionFeedback();
        case 'medium':
          return h.impactFeedback('medium');
        case 'heavy':
          return h.impactFeedback('heavy');
        case 'success':
        case 'warning':
        case 'error':
          return h.notificationFeedback(kind);
        default:
          return h.impactFeedback('light');
      }
    })
    .catch(() => {
      // A bridge that will not buzz is silence, not an error worth surfacing.
    });
}

/** The impl handed to HapticsProvider, or undefined to keep the kit's web
 *  engine (Android web) / no-op (desktop). */
export const hapticsImpl = nativeHaptics ? fireNativeHaptic : undefined;

/**
 * The tier below the kit's seven kinds: UIImpactFeedbackGenerator's `soft`
 * style, the gentlest thing the Taptic Engine says. Texture, not events -
 * the fine ratchet between the disc's real detents, the patter of items
 * landing on a page. Same gates as everything else.
 */
export function fireMicroTick(): void {
  if (!nativeHaptics) return;
  if (!hapticsPref()) return;
  void plugin()
    .then((h) => h.impactFeedback('soft'))
    .catch(() => {
      // Silence, as ever.
    });
}

// --- the tap tick ---------------------------------------------------------

/** What counts as something you TAP, and so something that should answer. */
const TAPPABLE =
  'button, a, input, select, textarea, label, summary, [role="button"], [role="menuitem"],' +
  ' [role="menuitemradio"], [role="menuitemcheckbox"], [role="tab"], [role="switch"],' +
  ' [role="option"], [role="link"], [contenteditable="true"]';

/** How far a finger may travel and still have been a tap rather than a drag. */
const TAP_SLOP_PX = 10;
/** How long it may rest and still be a tap rather than a press-and-hold. */
const TAP_MAX_MS = 700;

/**
 * The app-wide tap tick.
 *
 * The kit ships this as one delegated POINTERDOWN listener, which is why it had
 * to be switched off: a scroll begins with a pointerdown on whatever card sits
 * under the thumb, so flicking a shelf buzzed the whole way down and the app
 * felt like it was pushing back. The distinction the kit misses is that a tap
 * is only a tap in hindsight - you know at pointerUP, once the finger has
 * lifted without travelling.
 *
 * So this waits: it remembers where a touch started, and fires only if the
 * finger lifts near where it landed, quickly, on something actually tappable.
 * Scrolls, drags, swipes and long-presses all fail that test and stay silent,
 * while every button, row and tab answers. Touch only - a mouse has no motor -
 * and gated by the same preference as everything else, so the Settings switch
 * governs this too.
 *
 * Returns its own cleanup.
 */
export function installTapHaptics(): () => void {
  if (!nativeHaptics) return () => {};
  let startX = 0;
  let startY = 0;
  let startAt = 0;
  let armed = false;

  const onDown = (e: PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    const el = e.target instanceof Element ? e.target.closest(TAPPABLE) : null;
    armed = el !== null;
    startX = e.clientX;
    startY = e.clientY;
    startAt = e.timeStamp;
  };
  const onUp = (e: PointerEvent) => {
    if (!armed) return;
    armed = false;
    if (e.pointerType === 'mouse') return;
    if (Math.abs(e.clientX - startX) > TAP_SLOP_PX) return;
    if (Math.abs(e.clientY - startY) > TAP_SLOP_PX) return;
    if (e.timeStamp - startAt > TAP_MAX_MS) return;
    // The finger has to still be ON something tappable: a press that began on a
    // row and lifted over the page is a cancelled tap, not a quiet one.
    const el = e.target instanceof Element ? e.target.closest(TAPPABLE) : null;
    if (!el) return;
    fireNativeHaptic('selection');
  };
  const onCancel = () => {
    armed = false;
  };

  // Capture, so a handler that stops propagation cannot silence the hand.
  window.addEventListener('pointerdown', onDown, { capture: true, passive: true });
  window.addEventListener('pointerup', onUp, { capture: true, passive: true });
  window.addEventListener('pointercancel', onCancel, { capture: true, passive: true });
  return () => {
    window.removeEventListener('pointerdown', onDown, { capture: true });
    window.removeEventListener('pointerup', onUp, { capture: true });
    window.removeEventListener('pointercancel', onCancel, { capture: true });
  };
}

// --- the preference -------------------------------------------------------

const PREF_KEY = 'attackfm-haptics';
const listeners = new Set<() => void>();

/** On by default anywhere there is a motor to feel; a stored choice wins. */
export function hapticsPref(): boolean {
  try {
    const stored = localStorage.getItem(PREF_KEY);
    if (stored === 'on') return true;
    if (stored === 'off') return false;
  } catch {
    // Fall through to the default.
  }
  return isMobile;
}

export function setHapticsPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    // The choice still applies for this run.
  }
  for (const l of listeners) l();
}

/** The switch's state, live across every component that shows it. */
export function useHapticsPref(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    hapticsPref,
    () => false,
  );
}
