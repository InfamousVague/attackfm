//! The one version the app should ever say out loud.
//!
//! There are genuinely two numbers now, and they move separately:
//!
//!   - The FRONTEND version - package.json, bumped by `npm run ship`, baked in
//!     by Vite as __AFM_VERSION__, and superseded at boot whenever the loader
//!     runs a downloaded bundle instead (window.__afmBundleVersion). This is
//!     the version of everything on screen, and the number OTA updates move.
//!   - The SHELL version - tauri.conf.json, stamped by the store-release
//!     ritual, frozen inside the installed binary until the next APK/IPA.
//!
//! APP_VERSION is the frontend one: it is what "what am I running?" means
//! day to day, and it is the only number that changes when an update lands -
//! a version readout that never moved after an OTA was how four releases
//! shipped while every device silently showed 0.3.38.

import tauriConf from '../../src-tauri/tauri.conf.json';

/** The version Vite baked into this build of the frontend. */
declare const __AFM_VERSION__: string;

function frontendVersion(): string {
  // Set by the boot loader in index.html before any module runs, so a const
  // computed at module load is already true for downloaded bundles. Guarded
  // for the dev server / a plain browser tab, where neither exists.
  try {
    if (typeof window !== 'undefined' && window.__afmBundleVersion) {
      return window.__afmBundleVersion;
    }
  } catch {
    // Fall through to the baked-in version.
  }
  return typeof __AFM_VERSION__ === 'string' ? __AFM_VERSION__ : tauriConf.version;
}

/** The frontend actually running - embedded or downloaded. */
export const APP_VERSION: string = frontendVersion();

/** The native binary's own stamp; moves only with a store/sideload install. */
export const SHELL_VERSION: string = tauriConf.version;
