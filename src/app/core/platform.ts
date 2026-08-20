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
  if (/iPad/i.test(ua)) return true;
  // iPadOS 13+ claims to be a Mac, and a Tauri iOS webview can report a
  // Mac-class agent too (no "iPhone" in the string at all). A real Mac has no
  // touchscreen, so a Mac agent paired with ANY touch capability - touch
  // points, touch events, or a coarse pointer - is a phone or tablet wearing a
  // Mac's clothes. Any one of the three is enough; a desktop trips none of them.
  const touchy =
    (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0) ||
    (typeof window !== 'undefined' && 'ontouchstart' in window) ||
    (typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches);
  if (/Macintosh/i.test(ua) && touchy) return true;
  return false;
})();

export const isIOS = /iPhone|iPod|iPad/i.test(userAgent()) || (isMobile && /Macintosh/i.test(userAgent()));

/** True on Android, in the app or the browser. */
export const isAndroid = /Android/i.test(userAgent());

/*
 * Publish the platform to CSS.
 *
 * `html[data-platform='android']` has been sitting in the dock contract
 * (05-the-dock-contract-a) since it was written, and NOTHING has ever set the
 * attribute - so the whole Android branch of the nav has never once applied.
 * A stylesheet cannot sniff a user agent, so this is the only side that can
 * answer it, and the fact is already computed here.
 *
 * From the module body rather than an effect: the chrome is positioned by
 * these rules on the first paint, and a platform arriving one render later
 * would move the nav after it was already on screen.
 */
if (typeof document !== 'undefined') {
  document.documentElement.dataset.platform = isAndroid ? 'android' : isIOS ? 'ios' : 'desktop';
}

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
