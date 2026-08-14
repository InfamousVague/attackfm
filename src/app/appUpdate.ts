//! Pulling a newer frontend from your own hub.
//!
//! The half of over-the-air updates that lives in the app: ask the server what
//! bundle it is publishing, decide whether this device may run it, and fetch
//! it for the NEXT launch. Nothing is ever swapped underneath a running app -
//! a bundle that replaced itself mid-session would tear the React tree out
//! from under whatever was on screen, and this app is often mid-song.
//!
//! The dangerous half is in src-tauri/src/bundle.rs, which verifies checksums,
//! refuses bundles that need newer native code, and quarantines any version
//! that fails to boot. This module only decides WHEN to ask.

import { isTauri } from './tauri.ts';
import type { ServerSession } from './server.ts';

/** What the server publishes at `/api/app/bundle`. */
export interface BundleManifest {
  version: string;
  /** The native generation this bundle was built against. */
  native: number;
  files: { name: string; sha256: string; bytes?: number }[];
  /** What changed, as markdown-ish lines. Shown before and after applying. */
  notes?: string;
}

export interface BundleState {
  active: string | null;
  pending: string | null;
  quarantined: string[];
  nativeGeneration: number;
  dir: string | null;
}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke(cmd, args)) as T;
  } catch {
    // An older binary without these commands: the app simply never updates
    // itself, which is exactly how it behaved before this existed.
    return null;
  }
}

// --- what changed ----------------------------------------------------------

const NOTES_KEY = 'attackfm-bundle-notes';
const SEEN_KEY = 'attackfm-notes-seen';

function readNotes(): Record<string, string> {
  try {
    const raw = localStorage.getItem(NOTES_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Keep a version's notes on the device.
 *
 * Stored rather than fetched when needed, because the moment they are most
 * wanted is straight after the update has been applied - and that is a fresh
 * boot, possibly offline, where asking the hub again would answer nothing. The
 * map is trimmed to a handful: nobody scrolls back through release notes.
 */
function rememberNotes(version: string, notes: string): void {
  if (!notes.trim()) return;
  try {
    const all = readNotes();
    all[version] = notes;
    const keys = Object.keys(all);
    if (keys.length > 6) for (const k of keys.slice(0, keys.length - 6)) delete all[k];
    localStorage.setItem(NOTES_KEY, JSON.stringify(all));
  } catch {
    // Then the update simply arrives without its story.
  }
}

/** What changed in a given version, if this device was told. */
export function notesFor(version: string | null): string | null {
  if (!version) return null;
  return readNotes()[version] ?? null;
}

/**
 * The notes for the version now running, if they have never been shown.
 *
 * This is the payoff of the whole changelog: you restart, and the app tells you
 * what it just became. Returns null once acknowledged, and null on a version
 * whose notes were never delivered.
 */
export function unseenNotes(): { version: string; notes: string } | null {
  const version = currentVersion();
  let seen: string | null = null;
  try {
    seen = localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
  if (seen === version) return null;
  const notes = notesFor(version);
  if (!notes) {
    // Nothing to say for this version: mark it seen so a later version with
    // notes is not shadowed by an old unacknowledged one.
    markNotesSeen();
    return null;
  }
  return { version, notes };
}

export function markNotesSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, currentVersion());
  } catch {
    // It will offer once more next launch; harmless.
  }
}

/** Split the stored blob into lines a list can render. */
export function notesLines(notes: string): string[] {
  return notes
    .split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, '').trim())
    .filter(Boolean);
}

// --- what is waiting, and who wants to know ---------------------------------

/** The version downloaded and pointed at, but not yet running. */
let staged: string | null = null;
const watchers = new Set<() => void>();

/**
 * The update the next launch will run, if it differs from this one.
 *
 * Null while there is nothing waiting - which is almost always. A banner reads
 * this rather than polling, so nothing on screen changes until a download has
 * actually landed and been verified.
 */
export function stagedBundle(): string | null {
  return staged;
}

export function watchBundle(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function announce(version: string | null): void {
  if (staged === version) return;
  staged = version;
  for (const fn of watchers) fn();
}

/**
 * Apply a staged update.
 *
 * A plain reload is the whole mechanism: it re-parses index.html, which runs
 * the boot loader again, which asks the native side what is active and finds
 * the newly installed bundle. No process restart, no app-store round trip -
 * and because the swap only ever happens at a boot, nothing is torn out from
 * under a running screen.
 */
export function applyStagedBundle(): void {
  window.location.reload();
}

export function bundleState(): Promise<BundleState | null> {
  return call<BundleState>('bundle_state');
}

/**
 * Tell the native side the running bundle came up.
 *
 * This is the other end of the wager `bundle_begin_boot` staked in the boot
 * loader. It has to be called from somewhere that only runs once the app is
 * genuinely working - not from a module top level, which executes before React
 * has rendered anything and would happily bless a bundle that then threw.
 */
export function reportBootOk(): void {
  if (!window.__afmBundleVersion) return;
  void call('bundle_boot_ok');
}

/** The version baked into this build, injected by Vite. */
declare const __AFM_VERSION__: string;

/** The version actually running, or null on the embedded bundle. */
export function runningBundle(): string | null {
  return window.__afmBundleVersion ?? null;
}

/**
 * What is on screen right now, downloaded or embedded.
 *
 * The embedded fallback is what stops a fresh install from treating the hub's
 * published bundle as news about itself: with no downloaded bundle there is no
 * `active` version to compare against, so without this every new device would
 * immediately download the bytes it already has and announce an update to the
 * version it is running.
 */
export function currentVersion(): string {
  return runningBundle() ?? __AFM_VERSION__;
}

export async function revertToEmbedded(): Promise<BundleState | null> {
  return call<BundleState>('bundle_revert');
}

/**
 * Ask the server what it is publishing, and install it if it is newer and this
 * build can run it.
 *
 * Returns the version staged for next launch, or null when there was nothing
 * to do. Deliberately quiet about failures: a hub that is off, an older server
 * with no such endpoint, or a bundle built for newer native code are all
 * ordinary states, not errors worth interrupting a listener for.
 */
export async function checkForBundle(session: ServerSession): Promise<string | null> {
  if (!isTauri()) return null;
  const state = await bundleState();
  if (!state) return null;
  // Installed on an earlier run and still not running: the banner belongs up
  // now, before any network call, so a device that is offline still learns
  // there is an update waiting for it.
  if (state.active && state.active !== runningBundle()) announce(state.active);

  let manifest: BundleManifest;
  try {
    const res = await fetch(`${session.url}/api/app/bundle`, {
      headers: { authorization: `Bearer ${session.token}` },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    manifest = (await res.json()) as BundleManifest;
  } catch {
    return null;
  }

  if (!manifest?.version || !Array.isArray(manifest.files)) return null;
  // Already running it, already staged, or already known bad here.
  if (manifest.version === currentVersion()) return null;
  if (manifest.version === state.active) return null;
  if (state.quarantined.includes(manifest.version)) return null;
  // The guard that keeps a new bundle off an old binary. The native side
  // refuses this too - twice, because getting it wrong is unrecoverable
  // without a reinstall.
  if ((manifest.native ?? 0) > state.nativeGeneration) return null;

  const files = manifest.files.map((f) => ({
    name: f.name,
    sha256: f.sha256,
    url: `${session.url}/api/app/bundle/${encodeURIComponent(f.name)}`,
  }));

  const next = await call<BundleState>('bundle_install', {
    version: manifest.version,
    native: manifest.native ?? 0,
    files,
  });
  if (next?.active !== manifest.version) return null;
  // Kept BEFORE announcing, so the banner that appears can already show what
  // is in the update rather than naming a version number and nothing else.
  if (manifest.notes) rememberNotes(manifest.version, manifest.notes);
  announce(manifest.version);
  return manifest.version;
}

declare global {
  interface Window {
    /** Written by the boot loader in index.html; null on the embedded bundle. */
    __afmBundleVersion?: string | null;
  }
}
