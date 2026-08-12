//! The one version the app should ever say out loud.
//!
//! There were two, and the UI read the wrong one. `package.json` is the
//! workspace manifest and nothing bumps it - the release ritual stamps
//! `src-tauri/tauri.conf.json` (and the iOS plist from it), because that is
//! the number that ends up inside the shipped binary and on TestFlight. So
//! About proudly showed v0.1.0 for every build ever made.
//!
//! Read the file the release actually writes, at build time: the value is
//! then true by construction for whatever bundle it was compiled into, works
//! in a browser tab as well as on device, and needs no async call.
import tauriConf from '../../src-tauri/tauri.conf.json';

export const APP_VERSION: string = tauriConf.version;
