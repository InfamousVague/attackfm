#!/usr/bin/env node
/**
 * Clears the copied iOS build artifacts before a build.
 *
 * Tauri's iOS build finishes by `rename()`-ing the app Xcode produced into
 * `src-tauri/gen/apple/build/<target>/`. On macOS `rename()` fails with
 * ENOTEMPTY when the destination directory already exists and has anything in
 * it - so the FIRST build of a target works and every one after it dies with:
 *
 *     failed to rename app .../AttackFM.app: Directory not empty (os error 66)
 *
 * The build itself has already succeeded by then, which is what makes it
 * confusing: the log says `** BUILD SUCCEEDED **` a few lines above the error.
 *
 * This is cheap. Only the final copied bundles live here; the compiled objects
 * are in DerivedData and are untouched, so a cleaned rebuild re-links and
 * re-copies rather than recompiling the Rust and the Swift from scratch.
 */
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD_DIR = join(ROOT, 'src-tauri/gen/apple/build');

// The archive is where the rename reads FROM, and the per-target directories
// are where it writes TO; a stale copy of either is enough to wedge a build.
for (const stale of ['app_iOS.xcarchive', 'arm64', 'arm64-sim', 'x86_64-sim']) {
  rmSync(join(BUILD_DIR, stale), { recursive: true, force: true });
}

// Externals/<arch>/<profile>/libapp.a is where the Build Rust Code phase drops
// the staticlib, and Xcode folder-syncs the whole tree into the bundle. After
// one debug AND one release build both profiles exist, the sync sees two
// sources for one libapp.a, and every later build - either configuration -
// dies with "Multiple commands produce ... libapp.a". Clearing it just costs
// the re-copy; the build phase recreates the profile it needs.
rmSync(join(ROOT, 'src-tauri/gen/apple/Externals'), { recursive: true, force: true });

// gen/apple/assets is the staging copy of the web build that Xcode folder-syncs
// into the .app. Tauri copies the fresh dist in but never prunes what is
// already there, so old hashed bundles - and, worse, an old index.html that
// still points at one - pile up and can ship in place of the current build.
// (Vite keeps prior bundles in dist too, so the stale index.html has something
// to resolve to.) Clearing it forces the current dist, and only it, into the
// bundle. Cheap: the build re-copies immediately.
rmSync(join(ROOT, 'src-tauri/gen/apple/assets'), { recursive: true, force: true });
rmSync(join(ROOT, 'dist'), { recursive: true, force: true });
