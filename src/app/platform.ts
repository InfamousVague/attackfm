/**
 * Which kind of machine the app is running on.
 *
 * The app used to answer one question - "am I inside Tauri?" - and use it for
 * two different things: whether there is a filesystem to read, and whether to
 * draw window chrome. On a phone those answers diverge. A Tauri iOS build is
 * very much inside Tauri, but it has no window to decorate, no traffic lights
 * to inset, no folder for a user to pick, and no room for a title bar with a
 * search field in it.
 *
 * So the platform is named here once, and every surface asks the question it
 * actually means.
 */

import { isTauri } from './tauri.ts';

function userAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

/**
 * True on iOS and Android, in the app or the browser.
 *
 * Sniffed from the user agent rather than asked of a plugin: Tauri's mobile
 * webviews report a stock iOS/Android agent, the check costs nothing at import
 * time, and the alternative - `@tauri-apps/plugin-os` - is an async call plus a
 * Rust plugin for a fact that never changes during a run.
 *
 * iPadOS is the awkward one: it reports itself as a Mac, so it is caught by the
 * touch test rather than the name.
 */
export const isMobile = (() => {
  const ua = userAgent();
  if (/Android|iPhone|iPod/i.test(ua)) return true;
  // iPad on iPadOS 13+ claims to be a Mac; a Mac with a touchscreen does not
  // exist, so the pair of them together is the tell.
  if (/iPad/i.test(ua)) return true;
  if (/Macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1) {
    return true;
  }
  return false;
})();

export const isIOS = /iPhone|iPod|iPad/i.test(userAgent()) || (isMobile && /Macintosh/i.test(userAgent()));

/**
 * True only for a real desktop window: something with a frame to decorate and
 * a title bar worth drawing. This is what the window chrome should key on.
 */
export const isDesktopApp = isTauri() && !isMobile;

/**
 * True where the app can read the machine's own music folder.
 *
 * Deliberately false on mobile even though Tauri is present. iOS has no
 * user-visible music directory an app may walk, and a phone is the listening
 * end of this system rather than the storing end - which is the entire reason
 * the server exists.
 */
export const hasLocalLibrary = isTauri() && !isMobile;

/**
 * Whether a plugin that shells out to a subprocess can work here. Mobile
 * sandboxes forbid spawning executables, so the importer - which drives a
 * Python downloader - has nothing to run.
 */
export const canRunSubprocesses = isTauri() && !isMobile;
