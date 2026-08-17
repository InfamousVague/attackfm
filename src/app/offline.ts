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

import { effectsOn } from './effects.ts';
import { isTauri, setOfflineAudioResolver, type Track } from './tauri.ts';

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

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return (await invoke(cmd, args)) as T;
  } catch {
    // An older build without the commands, or a platform without a disk to
    // write to: the app simply streams, exactly as it did before.
    return null;
  }
}

/** Read the folder once at boot; every later answer comes from the map. */
export async function hydrateOffline(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const list = await call<OfflineEntry[]>('offline_list');
  if (list) {
    held = new Map(list.map((e) => [e.key, e.path]));
    announce();
  }
}

/** Everything held, for the Settings pane. */
export async function offlineEntries(): Promise<OfflineEntry[]> {
  return (await call<OfflineEntry[]>('offline_list')) ?? [];
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
  return call<{ freeBytes: number | null; heldBytes: number }>('offline_space');
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
function offlineSource(path: string): string | null {
  if (effectsOn()) return null;
  return heldPath(path);
}

// Registered rather than imported: tauri.ts is the bottom of the graph and
// must not depend on the app above it.
setOfflineAudioResolver(offlineSource);

/**
 * Keep a track. `url` is the same stream URL playback would have used, so a
 * pin costs exactly one ordinary read of your own server.
 */
export async function pinTrack(track: Track, url: string): Promise<boolean> {
  if (!isTauri() || held.has(track.path)) return held.has(track.path);
  const ext = (track.codec || '').replace(/[^a-z0-9]/gi, '') || 'audio';
  // Deliberately NOT the swallowing call(): the Rust side names its failures
  // ("server answered 401", "fetch failed: ...") and this is the one command
  // whose failure somebody is standing there trying to diagnose. Swallowing
  // here is why a wall of 147 red tiles once carried no reasons at all.
  const { invoke } = await import('@tauri-apps/api/core');
  const entry = (await invoke('offline_pin', { key: track.path, url, ext })) as OfflineEntry | null;
  if (!entry) return false;
  held.set(entry.key, entry.path);
  announce();
  return true;
}

export async function unpinTrack(path: string): Promise<void> {
  await call('offline_unpin', { key: path });
  held.delete(path);
  announce();
}

