import { useSyncExternalStore } from 'react';

/**
 * The share-my-listening switch: where it is kept, and how it is read.
 *
 * ON by default, and only for people who have never said otherwise: an
 * explicit `off` is honoured forever, so nobody who once turned this off is
 * quietly turned back on by a later release. Without a default the friends
 * page is a grid of empty cards - the numbers are what make it about music
 * rather than a contact list - and a friend is someone you already accepted.
 *
 * What the switch being on MEANS - which announcements go out, and to whom -
 * lives in `listeningShare.tsx` beside the bridge that does the announcing.
 * This is only the preference: the key, the reading, the writing, and the
 * subscription every surface showing the switch shares.
 *
 * THE KEY IS THE CONTRACT. `attackfm-share-listening` is written on devices
 * that are already out there; respell it and every one of them silently
 * forgets a privacy choice its owner made on purpose, which is the one way
 * this preference can do real harm.
 */

const SHARE_KEY = 'attackfm-share-listening';

const listeners = new Set<() => void>();

export function sharingEnabled(): boolean {
  try {
    // Only an explicit refusal turns it off. Anything else - never asked, or
    // a value from some older build - reads as on.
    return localStorage.getItem(SHARE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSharing(on: boolean): void {
  try {
    localStorage.setItem(SHARE_KEY, on ? 'on' : 'off');
  } catch {
    // A store that will not write costs the preference, not the page.
  }
  for (const l of listeners) l();
}

/** The switch's state, live across every component that shows it. */
export function useSharing(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    sharingEnabled,
    // The server-render fallback matches the default, or the switch would
    // flash off on first paint for everyone who never touched it.
    () => true,
  );
}
