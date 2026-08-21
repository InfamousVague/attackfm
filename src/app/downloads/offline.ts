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


/** Read the folder once at boot; every later answer comes from the map. */
export async function hydrateOffline(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const list = await tauriCall<OfflineEntry[]>('offline_list');
  if (list) {
    held = new Map(list.map((e) => [e.key, e.path]));
    announce();
  }
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
  const entry = (await invoke('offline_pin', { key: track.path, url, ext })) as OfflineEntry | null;
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

export async function unpinTrack(path: string): Promise<void> {
  await tauriCall('offline_unpin', { key: path });
  held.delete(path);
  // Whatever removed it, the deliberate-keep mark goes with the file. Here
  // rather than at the call sites so no route can leave one behind: a mark
  // outliving its song protects nothing and hides a byte from the count.
  unmarkPinned(path);
  announce();
}

