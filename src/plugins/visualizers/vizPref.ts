/**
 * Which visualizer is showing - one number, remembered on the device, shared
 * between the art square (tap to cycle) and the settings pane (pick from a
 * grid). The two read the same key and hear each other through one window
 * event, so a pick in Settings changes the square that is already on screen
 * and a tap on the square moves the pane's check.
 */

const KEY = 'attackfm-visualizer';

/** Fired on the window after every write; listeners re-read the key. */
export const VIZ_EVENT = 'attackfm-visualizer-change';

export function readVizIndex(): number {
  try {
    const n = parseInt(localStorage.getItem(KEY) ?? '0', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function writeVizIndex(index: number): void {
  try {
    localStorage.setItem(KEY, String(index));
  } catch {
    // Storage unavailable - the choice still applies for this session.
  }
  window.dispatchEvent(new Event(VIZ_EVENT));
}
