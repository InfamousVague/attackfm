/**
 * The one privacy switch for outbound metadata lookups.
 *
 * Two core features quietly talk to third parties: lyrics come from LRCLIB
 * and album art from the iTunes Search API, both keyed by track metadata.
 * This flag lets a user keep the app entirely between their devices and
 * their own server. It lives outside React because both callers are plain
 * async functions (lyrics.ts, albumArt.ts) - they read the flag at each
 * call, so a flip applies to the very next lookup with no plumbing.
 */

const KEY = 'attackfm-online-metadata';

export function onlineMetadataEnabled(): boolean {
  try {
    // Absent means on: the lookups are the shipped behaviour, and only an
    // explicit 'off' turns them away.
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setOnlineMetadata(on: boolean): void {
  try {
    if (on) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, 'off');
  } catch {
    // Storage refused: the choice just will not survive a relaunch.
  }
}
