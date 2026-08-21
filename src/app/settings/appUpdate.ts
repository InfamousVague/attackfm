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

import { isTauri, tauriCall } from '../core/tauri.ts';
import { REGISTRY_URL } from '../servers/registry.ts';
import { stashDeck } from '../player/deckHandoff.ts';
import { recordDiag } from '../diag/diagLog.ts';

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

// --- what changed ----------------------------------------------------------

const NOTES_KEY = 'attackfm-bundle-notes';
const SEEN_KEY = 'attackfm-notes-seen';
/** version -> the version it replaced, so the modal can say "0.3.46 → 0.3.47". */
const FROM_KEY = 'attackfm-bundle-from';
/** The last version whose arrival was ANNOUNCED in the modal. */
const TOLD_KEY = 'attackfm-update-told';

/** What this device was running when `version` was staged. */
export function previousFor(version: string): string | null {
  try {
    const all = JSON.parse(localStorage.getItem(FROM_KEY) || '{}') as Record<string, string>;
    return all[version] ?? null;
  } catch {
    return null;
  }
}

function rememberPrevious(version: string, from: string): void {
  if (!from || from === version) return;
  try {
    const all = JSON.parse(localStorage.getItem(FROM_KEY) || '{}') as Record<string, string>;
    all[version] = from;
    const keys = Object.keys(all);
    if (keys.length > 6) for (const k of keys.slice(0, keys.length - 6)) delete all[k];
    localStorage.setItem(FROM_KEY, JSON.stringify(all));
  } catch {
    // Then the modal names one version instead of two.
  }
}

/**
 * Whether this version's arrival still owes the listener an announcement.
 *
 * The modal is a once-per-version event, not a state: it interrupts, so it
 * gets exactly one turn. Said no (or said nothing and closed it) and the quiet
 * banner carries on holding the offer.
 */
export function shouldAnnounce(version: string): boolean {
  try {
    return localStorage.getItem(TOLD_KEY) !== version;
  } catch {
    return false;
  }
}

export function markAnnounced(version: string): void {
  try {
    localStorage.setItem(TOLD_KEY, version);
  } catch {
    // It offers once more next launch; harmless.
  }
}

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
 *
 * Except a song, which is the one thing on screen that cannot simply be drawn
 * again. So the deck is written down first - synchronously, because the next
 * statement ends this document - and picked back up on the other side. Every
 * "restart to update" button in the app comes through here, which is why this
 * is the only place that needs to know.
 */
export function applyStagedBundle(): void {
  stashDeck();
  window.location.reload();
}

export function bundleState(): Promise<BundleState | null> {
  return tauriCall<BundleState>('bundle_state');
}

/**
 * Tell the native side the running bundle came up.
 *
 * This is the other end of the wager `bundle_begin_boot` staked in the boot
 * loader. It has to be called from somewhere that only runs once the app is
 * genuinely working - not from a module top level, which executes before React
 * has rendered anything and would happily bless a bundle that then threw.
 *
 * Awaitable, and that matters: `bundle_state` CONSUMES an outstanding wager
 * and reads it as a failed boot, so anything that asks must be certain this
 * has landed first. Fire-and-forget left the two IPC calls racing.
 */
export async function reportBootOk(): Promise<void> {
  await settleBootWager();
}

/**
 * Settle the wager, and say whether it actually landed.
 *
 * `tauriCall` cannot answer that: it returns null both when a command succeeds
 * with no value - which `bundle_boot_ok` does - and when the call failed and
 * was swallowed. For most callers that is fine. For this one it is the whole
 * question, because the next thing that happens is `bundle_state`, and
 * `bundle_state` reads an unsettled wager as a boot that never finished and
 * DELETES the running bundle. A caller that cannot tell whether the settle
 * landed is betting the app on it.
 *
 * So this one does its own invoke and lets the failure be visible.
 */
export async function settleBootWager(): Promise<boolean> {
  // Nothing staked: the embedded bundle never places the bet.
  if (!window.__afmBundleVersion) return true;
  if (!isTauri()) return true;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('bundle_boot_ok');
    return true;
  } catch (e) {
    recordDiag('boot', `could not settle the boot wager: ${e instanceof Error ? e.message : e}`);
    return false;
  }
}

/** The version baked into this build, injected by Vite. */
declare const __AFM_VERSION__: string;
/** False only in deliberately pinned test builds. */
declare const __AFM_UPDATES_ENABLED__: boolean;

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
  return tauriCall<BundleState>('bundle_revert');
}

/** Dotted-numeric compare: is `a` strictly newer than `b`? */
function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number(n) || 0);
  const pb = b.split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * A fresh install outranks the older download it used to hide behind.
 *
 * The boot loader always prefers a downloaded bundle - right for the OTA flow,
 * wrong the day a NEWER app is installed over it (a new APK, a store update):
 * the old bundle kept the floor and the new frontend inside the binary never
 * ran, silently, until some later OTA happened to arrive through whatever door
 * the old client still checked. If the embedded frontend is newer than the
 * bundle now running, hand the floor back and reboot onto it - once, since
 * after the revert there is no bundle left to shadow anything.
 */
export async function reclaimEmbeddedIfNewer(): Promise<void> {
  const running = runningBundle();
  if (!running || !newerVersion(__AFM_VERSION__, running)) return;
  const state = await revertToEmbedded();
  if (state && !state.active) window.location.reload();
}

/**
 * A check's outcome, in words a settings row can show.
 *
 * The quiet automatic path discards this; the "Check for updates" button in
 * Settings exists BECAUSE four releases went out while every failure in this
 * chain was silent - a device that had been 401ing for weeks looked identical
 * to one that was up to date. Whatever happens, the answer can now be seen.
 */
export type UpdateCheckOutcome =
  | { state: 'staged'; version: string }
  | { state: 'current'; version: string }
  | { state: 'unavailable'; why: string }
  | { state: 'error'; why: string };

/**
 * Ask attack.fm what it is publishing, and install it if it is newer and this
 * build can run it. Every outcome is named; `checkForBundle` below keeps the
 * old quiet contract for the automatic path.
 *
 * Updates come from the REGISTRY - the same central service sign-in does -
 * not from whichever music server the session happens to be on. One canonical
 * source for every device, and it works signed into nothing at all.
 */
export async function checkForUpdate(): Promise<UpdateCheckOutcome> {
  if (!isTauri()) return { state: 'unavailable', why: 'Updates apply to the installed app.' };
  if (!__AFM_UPDATES_ENABLED__) {
    return { state: 'unavailable', why: 'This test build is pinned and will not update itself.' };
  }
  const state = await bundleState();
  if (!state) return { state: 'unavailable', why: 'This build cannot swap its frontend.' };
  // Installed on an earlier run and still not running: the banner belongs up
  // now, before any network call, so a device that is offline still learns
  // there is an update waiting for it.
  if (state.active && state.active !== runningBundle()) announce(state.active);

  let manifest: BundleManifest;
  try {
    const res = await fetch(`${REGISTRY_URL}/v1/app/bundle`, { cache: 'no-store' });
    if (res.status === 404) return { state: 'unavailable', why: 'No update is published right now.' };
    if (!res.ok) return { state: 'error', why: `attack.fm answered ${res.status}.` };
    manifest = (await res.json()) as BundleManifest;
  } catch {
    return { state: 'error', why: 'Could not reach attack.fm.' };
  }

  if (!manifest?.version || !Array.isArray(manifest.files)) {
    return { state: 'error', why: 'The server sent a malformed manifest.' };
  }
  // Already running it, already staged, or already known bad here.
  if (manifest.version === currentVersion()) {
    return { state: 'current', version: manifest.version };
  }
  if (manifest.version === state.active) {
    announce(state.active);
    return { state: 'staged', version: manifest.version };
  }
  if (state.quarantined.includes(manifest.version)) {
    return {
      state: 'unavailable',
      why: `${manifest.version} failed to boot here before and is quarantined.`,
    };
  }
  // The guard that keeps a new bundle off an old binary. The native side
  // refuses this too - twice, because getting it wrong is unrecoverable
  // without a reinstall.
  if ((manifest.native ?? 0) > state.nativeGeneration) {
    return { state: 'unavailable', why: 'This update needs a newer app from the store.' };
  }

  // The download runs natively with a bare reqwest, which sets no headers.
  // The registry's file endpoint is public for exactly that reason - an auth
  // requirement on the old music-server route met those headerless fetches
  // with a 401, and every update since the first died silently right there.
  const files = manifest.files.map((f) => ({
    name: f.name,
    sha256: f.sha256,
    url: `${REGISTRY_URL}/v1/app/bundle/${encodeURIComponent(f.name)}`,
  }));

  const next = await tauriCall<BundleState>('bundle_install', {
    version: manifest.version,
    native: manifest.native ?? 0,
    files,
  });
  if (next?.active !== manifest.version) {
    return { state: 'error', why: 'The download failed verification and was discarded.' };
  }
  // Kept BEFORE announcing, so the modal that appears can already show what
  // is in the update rather than naming a version number and nothing else -
  // including the version it replaces, which is only knowable now, while the
  // outgoing one is still the one running.
  if (manifest.notes) rememberNotes(manifest.version, manifest.notes);
  rememberPrevious(manifest.version, currentVersion());
  announce(manifest.version);
  return { state: 'staged', version: manifest.version };
}

/**
 * The automatic path: same check, quiet contract. A registry that is briefly
 * unreachable is an ordinary state, not something to interrupt a listener
 * over - but it does get a console line, so a device inspected over CDP or
 * logcat shows WHY it is not updating instead of nothing at all.
 */
export async function checkForBundle(): Promise<string | null> {
  const outcome = await checkForUpdate();
  if (outcome.state === 'staged') return outcome.version;
  if (outcome.state === 'error' || outcome.state === 'unavailable') {
    console.info(`[update] ${outcome.why}`);
  }
  return null;
}

declare global {
  interface Window {
    /** Written by the boot loader in index.html; null on the embedded bundle. */
    __afmBundleVersion?: string | null;
    /**
     * What the binary underneath can do, also from the boot loader.
     *
     * Absent means an older binary, whose index.html predates this and never
     * set it - which is the only signal the frontend gets about which native
     * contract it is running on, and the reason the launch check can tell
     * whether it is safe to ask `bundle_state` before the app has mounted.
     */
    __afmNativeGeneration?: number;
  }
}
