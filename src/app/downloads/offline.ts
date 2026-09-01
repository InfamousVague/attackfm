//! The offline vault: your own library, held on this device.
//!
//! The hub is a box in a house, not a datacentre - it goes off, the wifi
//! drops, the plane door closes. A pinned track is a copy of a file this
//! device already had the right to stream, kept under the app's data
//! directory, and `loadAudioUrl` reaches for it before the network. Nothing
//! here acquires music: it is the same file, on this side of the wire.
//!
//! The disk is the index (see src-tauri/src/offline.rs), so the map below is
//! only a cache of it - rebuilt at boot, and never the authority. That is what
//! keeps a phone that was wiped, restored, or updated from believing it holds
//! songs it does not.

import { effectsOn } from '../player/effects.ts';
import { serverSeemsDown } from '../api/reachability.ts';
import { fxChainOn } from '../player/fxChain.ts';
import { stemDropParam } from '../player/stemDrop.ts';
import { trackIdFromPath } from '../server.ts';
import { isTauri, setOfflineAudioResolver, tauriCall, type Track } from '../core/tauri.ts';
import { unmarkPinned } from '../cache/cacheStore.ts';

/** Library path -> absolute file path on this device. */
let held = new Map<string, string>();
let hydrated = false;
const listeners = new Set<() => void>();

export interface OfflineEntry {
  key: string;
  path: string;
  bytes: number;
}

function announce(): void {
  for (const fn of listeners) fn();
}

/** Subscribe to pin/unpin, for the surfaces that draw the state. */
export function onOfflineChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}


/**
 * Read the folder at boot; every later answer comes from the map.
 *
 * The latch closes on SUCCESS, not on the attempt. It used to close before
 * the call and swallow the failure (tauriCall answers null for every invoke
 * error, by design), which meant one IPC hiccup at boot left the map empty
 * for the whole run - fifteen gigabytes of cached music on disk and the app
 * unable to see any of it, no log, no retry, nothing plays. Exactly the
 * airplane-mode shape. Three attempts with widening gaps cover a plugin that
 * was not ready in the first second of boot.
 */
/**
 * Point the vault at the browsable AttackFM folder, when Android's all-files
 * grant exists RIGHT NOW - and re-read the ledger afterwards, because a
 * migration moves every held file and the map's remembered paths die with it.
 *
 * Called from boot (below) AND from the Storage pane when the grant lands
 * mid-session. The second caller is the fix for a real hole: the grant flow
 * is open-app -> settings -> grant -> return, which means the app process
 * that boots after the grant is usually days away - the folder appeared (the
 * pane's own vaultDir() call creates it) while every download kept landing in
 * the private vault. Adoption has to chase the grant, not the next cold start.
 *
 * Returns how many files migrated, or null when there is nothing to adopt -
 * every step optional by design (browser, iOS, desktop, an older binary).
 */
export async function adoptVaultRoot(): Promise<number | null> {
  try {
    const native = (window as unknown as { AFMNative?: { vaultDir?: () => string | null } }).AFMNative;
    const root = native?.vaultDir?.();
    if (!root) return null;
    const moved = await tauriCall<number>('offline_set_root', { root });
    if (moved === null) return null;
    // Paths changed under the map: read the new folder as the truth.
    const list = await tauriCall<OfflineEntry[]>('offline_list');
    if (list) {
      hydrated = true;
      held = new Map(list.map((e) => [e.key, e.path]));
      announce();
    }
    return moved;
  } catch {
    return null;
  }
}

export async function hydrateOffline(): Promise<void> {
  if (hydrated) return;
  // BEFORE the first list: adopt the browsable folder when the grant already
  // exists, so the list below reads the folder the files now live in.
  await adoptVaultRoot();
  for (const delay of [0, 1500, 5000]) {
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const list = await tauriCall<OfflineEntry[]>('offline_list');
    if (list) {
      hydrated = true;
      held = new Map(list.map((e) => [e.key, e.path]));
      announce();
      return;
    }
  }
  // Give up for now, but not forever: a later explicit call may land.
}

/** Everything held, for the Settings pane. */
export async function offlineEntries(): Promise<OfflineEntry[]> {
  return (await tauriCall<OfflineEntry[]>('offline_list')) ?? [];
}

/** Whether this track plays without a network. */
export function isHeld(path: string): boolean {
  return held.has(path);
}

export function heldCount(): number {
  return held.size;
}

/** Room on the volume the vault lives on, and what the vault is using.
 *  `freeBytes` is null where it cannot be asked (a browser, an odd platform),
 *  which callers must read as "do not cache ahead" rather than "plenty". */
export async function offlineSpace(): Promise<{
  freeBytes: number | null;
  heldBytes: number;
} | null> {
  return tauriCall<{ freeBytes: number | null; heldBytes: number }>('offline_space');
}

/** The local file for a track, or null - the hook `loadAudioUrl` consults. */
export function heldPath(path: string): string | null {
  return held.get(path) ?? null;
}

/**
 * What `loadAudioUrl` actually consults - and the one place the effects rack
 * gets to override the vault.
 *
 * A held file is normally the best answer there is: no network, instant, free.
 * But the effects are applied by the SERVER as it encodes, so a local copy is
 * the one source that cannot have them. If the vault answered while an effect
 * was on, pinned tracks would quietly play dry and the switch would look
 * broken on exactly the songs someone cared about enough to keep.
 *
 * So while the rack has anything in it, the vault says it holds nothing, and
 * playback goes to the server to be coloured. Turning the effects off returns
 * every pinned track to playing offline.
 */
/**
 * The held file, unless the listener has asked for a sound it cannot make.
 *
 * A copy on this device beats the wire every time - except when what is wanted
 * is not what is in the file. The rack and the chain were already understood
 * here; a part taken OUT was not, and that was the whole of the bug where
 * seeking put the stems back. The held file is the finished mix, so it has no
 * way to be missing a part; handing it to the element silently undoes the
 * console, and because this resolver is consulted again on every reload, a
 * song could start correctly from the server and then flip to the whole mix
 * the moment anything reloaded it - a seek being the obvious way in, and the
 * device cache quietly acquiring the track mid-listen being the reason it
 * struck a song that had been fine a minute earlier.
 *
 * Keyed to THIS track rather than asked globally, the way `effectsOn` is: a
 * drop belongs to the song it was made on, so it must not push some other
 * song off its local copy.
 */
function offlineSource(path: string): string | null {
  /*
   * ...UNLESS THERE IS NO HUB.
   *
   * Every refusal below is the same trade: the server can render this song and
   * the copy on this device cannot, so the copy is declined in favour of the
   * stream. That is right while the server is answering and exactly wrong when
   * it has stopped - the choice stops being "with filters or without" and
   * becomes "without filters, or not at all". A song that plays unfiltered
   * beats a song that does not play, every time.
   *
   * This is the whole reason a liked song would not start with the home server
   * down: the vault had it, and the resolver was handing it back a null because
   * an effect was switched on weeks ago.
   */
  if (serverSeemsDown()) return heldPath(path);
  if (effectsOn() || fxChainOn()) return null;
  if (stemDropParam(trackIdFromPath(path)) !== null) return null;
  return heldPath(path);
}

// Registered rather than imported: tauri.ts is the bottom of the graph and
// must not depend on the app above it.
setOfflineAudioResolver(offlineSource);

/**
 * Keep a track. `url` is the same stream URL playback would have used, so a
 * pin costs exactly one ordinary read of your own server.
 */
export async function pinTrack(
  track: Track,
  url: string,
  opts?: {
    /** Overrides the codec-derived name. The cache uses it to record quality. */
    ext?: string;
    /** Reject a body that came back implausibly short. 0 disables the check. */
    minBytes?: number;
  },
): Promise<boolean> {
  if (!isTauri() || held.has(track.path)) return held.has(track.path);
  const ext = opts?.ext ?? ((track.codec || '').replace(/[^a-z0-9]/gi, '') || 'audio');
  // Deliberately NOT the swallowing tauriCall(): the Rust side names its failures
  // ("server answered 401", "fetch failed: ...") and this is the one command
  // whose failure somebody is standing there trying to diagnose. Swallowing
  // here is why a wall of 147 red tiles once carried no reasons at all.
  const { invoke } = await import('@tauri-apps/api/core');
  // The vault names the file with this - "Artist - Title" is what a person
  // browsing AttackFM/Music in a file manager should see. Optional end to
  // end: a binary from the hex era ignores the argument entirely.
  const name = [track.artist, track.title].filter(Boolean).join(' - ') || undefined;
  const entry = (await invoke('offline_pin', { key: track.path, url, ext, name })) as OfflineEntry | null;
  if (!entry) return false;
  // A transcode arrives with no Content-Length, and the Rust side only refuses a
  // download of exactly zero bytes - so an encoder that died mid-song hands back
  // a short but perfectly well-formed file, which is then renamed into place and
  // counted as held for good. Undone here rather than kept, and thrown rather
  // than returned false, so the sweep's retry loop treats it as the transient
  // failure it usually is.
  if (opts?.minBytes && entry.bytes < opts.minBytes) {
    await tauriCall('offline_unpin', { key: track.path });
    throw new Error(`download stopped early (${entry.bytes} bytes)`);
  }
  held.set(entry.key, entry.path);
  announce();
  return true;
}

/** Hex-encode a key the way the vault's legacy filenames did. */
function hexOf(key: string): string {
  return Array.from(new TextEncoder().encode(key), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** True when a held file still wears its hex-era name and deserves better. */
export function heldNameIsHex(key: string): boolean {
  const path = held.get(key);
  if (!path) return false;
  const base = path.split('/').pop() ?? '';
  return base.startsWith(hexOf(key));
}

/**
 * Rename hex-era files to "Artist - Title" in one batch. Purely cosmetic to
 * the player - the vault's ledger keeps the keys - but it is the difference
 * between a browsable folder and a wall of hex for anything cached before the
 * readable era. Swallowed on binaries too old to know the command.
 */
export async function rebrandHeld(items: { key: string; name: string }[]): Promise<void> {
  if (items.length === 0) return;
  const renamed = await tauriCall<OfflineEntry[]>('offline_rebrand', { items });
  if (!renamed || renamed.length === 0) return;
  for (const entry of renamed) held.set(entry.key, entry.path);
  announce();
}

export async function unpinTrack(path: string): Promise<void> {
  await tauriCall('offline_unpin', { key: path });
  held.delete(path);
  // Whatever removed it, the deliberate-keep mark goes with the file. Here
  // rather than at the call sites so no route can leave one behind: a mark
  // outliving its song protects nothing and hides a byte from the count.
  unmarkPinned(path);
  announce();
}

