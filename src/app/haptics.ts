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

// One patter per page arrival, however many components ask: mounting a page
// mounts its shelves too, and five drumrolls at once is a shudder, not a wave.
let lastPatter = 0;

/**
 * The felt half of a page's ripple-in: a short soft drumroll timed to the
 * entrance wave, so the items can be felt hitting the page. Ticks ride
 * timeouts rather than the animation events - the wave is CSS, and taking a
 * dependency on animation bookkeeping for a quarter-second flourish would
 * cost more than it pays.
 */
export function ripplePatter(): void {
  if (!nativeHaptics || !hapticsPref()) return;
  const now = performance.now();
  if (now - lastPatter < 700) return;
  lastPatter = now;
  for (let i = 0; i < 5; i += 1) {
    window.setTimeout(fireMicroTick, 60 + i * 70);
  }
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
