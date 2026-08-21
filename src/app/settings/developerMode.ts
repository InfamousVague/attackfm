import { useSyncExternalStore } from 'react';

/**
 * Developer mode: the switch behind the hidden tools.
 *
 * Unlocked by seventeen presses on the wordmark in About (see AboutSettings),
 * and from then on a plain switch at the top of the Developer pane. While it
 * is on, Settings grows a Developer section under About and shows Diagnostics;
 * while it is off both are absent from the sections array and so from the
 * rail, the phone list, recents chips and search at once.
 *
 * A LIVE store rather than a behaviourPrefs pair, and the difference matters:
 * this flag is flipped from INSIDE a child pane (About) and has to change the
 * PARENT's sections array on the spot. behaviourPrefs' on()/set() have no
 * change channel and `storage` events never fire in the tab that wrote them,
 * so SettingsModal would not learn about the flip until its next mount. This
 * is the same shape as core/haptics.ts: a module listener set and a
 * useSyncExternalStore hook.
 *
 * Device-local on purpose. It is deliberately NOT in prefsSync's SYNCED_KEYS:
 * a developer mode that followed your account onto your partner's phone would
 * be a surprise, and the file's comment enumerates why device facts stay home.
 */
const KEY = 'attackfm-developer-mode';
const listeners = new Set<() => void>();

export function developerModeEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false;
  }
}

export function setDeveloperMode(on: boolean): void {
  try {
    // Only the ON side is stored: absent means the shipped state, so a device
    // that never unlocked the tools carries no key at all.
    if (on) localStorage.setItem(KEY, 'on');
    else localStorage.removeItem(KEY);
  } catch {
    // Storage refused: the mode holds for this run and not beyond it.
  }
  for (const l of listeners) l();
}

/** The flag, live across every component that reads it. */
export function useDeveloperMode(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    developerModeEnabled,
    () => false,
  );
}
