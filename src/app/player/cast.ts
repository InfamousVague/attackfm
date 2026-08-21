import { useSyncExternalStore } from 'react';

/**
 * The page's side of Chromecast (CastBridge.kt is the Android side).
 *
 * The shape of the whole feature: THE PAGE STAYS THE BRAIN. The queue, what
 * plays next, where the scrubber is - all of it keeps living in the Player,
 * exactly as it does when the phone's own speaker is the output. A cast
 * session just moves the SOUND: the Player mutes its decks, mirrors what it
 * is doing to the TV, and follows the TV's clock. Nothing about playback
 * decision-making moves across the bridge, which is what keeps every other
 * feature (shuffle, repeat, sleep timers, the queue panel) working unchanged
 * while casting.
 *
 * State flows one way, whole: the native side pushes its entire truth as one
 * JSON snapshot into `window.__AFM_CAST__` on every change - no deltas, no
 * ordering to get wrong. This module keeps the latest snapshot for
 * useSyncExternalStore, and the snapshot object is REPLACED, never mutated,
 * so the store's identity contract holds (the playlist-page crash of 0.3.283
 * is the reason that sentence is written down).
 *
 * Everywhere that is not the Android app, `AFMNative.castState` does not
 * exist, the snapshot stays IDLE, and every verb is a no-op - callers need no
 * platform test of their own, same rule as the rest of the bridge.
 */

export interface CastDevice {
  id: string;
  name: string;
}

export interface CastMediaState {
  playing: boolean;
  positionMs: number;
  durationMs: number;
}

export interface CastSnapshot {
  /** Play services present and the framework stood up. */
  available: boolean;
  devices: CastDevice[];
  /** The connected TV, or null when not casting. */
  session: { device: string } | null;
  /** What the TV reports it is doing, or null when nothing is loaded. */
  media: CastMediaState | null;
  /** The TV's own volume, 0..1. */
  volume: number;
}

const IDLE: CastSnapshot = Object.freeze({
  available: false,
  devices: [],
  session: null,
  media: null,
  volume: 1,
});

let snapshot: CastSnapshot = IDLE;
const listeners = new Set<() => void>();
let installed = false;

function adopt(json: string): void {
  try {
    const parsed = JSON.parse(json) as Partial<CastSnapshot>;
    snapshot = {
      available: parsed.available === true,
      devices: Array.isArray(parsed.devices) ? (parsed.devices as CastDevice[]) : [],
      session:
        parsed.session && typeof parsed.session === 'object'
          ? (parsed.session as { device: string })
          : null,
      media:
        parsed.media && typeof parsed.media === 'object'
          ? (parsed.media as CastMediaState)
          : null,
      volume: typeof parsed.volume === 'number' ? parsed.volume : 1,
    };
    for (const listener of listeners) listener();
  } catch {
    // A frame we cannot parse is not worth breaking the store over.
  }
}

/** Handler first, THEN the boot read: a push that races the install can only
 *  be a duplicate of what castState() returns, never a loss. */
function install(): void {
  if (installed) return;
  installed = true;
  const bridge = window.AFMNative;
  if (!bridge?.castState) return; // not Android, or a shell from before casting
  window.__AFM_CAST__ = adopt;
  try {
    adopt(bridge.castState());
  } catch {
    // The first push will say it instead.
  }
}

function subscribe(callback: () => void): () => void {
  install();
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function useCastSnapshot(): CastSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => IDLE);
}

// --- the verbs, every one safe everywhere ----------------------------------

/** Active scan while a chooser is on screen, passive otherwise - active
 *  discovery wakes every cast device on the network over and over. */
export function castDiscovery(active: boolean): void {
  try {
    window.AFMNative?.castDiscovery?.(active);
  } catch {
    // Best-effort, like the rest of the bridge.
  }
}

export function castConnect(routeId: string): void {
  try {
    window.AFMNative?.castConnect?.(routeId);
  } catch {
    // Same.
  }
}

export function castDisconnect(): void {
  try {
    window.AFMNative?.castDisconnect?.();
  } catch {
    // Same.
  }
}

export interface CastLoad {
  url: string;
  contentType: string;
  title: string;
  artist: string;
  album: string;
  /** An https URL the TV itself can fetch, or absent. Never a blob. */
  art?: string;
  durationMs: number;
  positionMs: number;
  autoplay: boolean;
}

export function castLoad(media: CastLoad): void {
  try {
    window.AFMNative?.castLoad?.(JSON.stringify(media));
  } catch {
    // Same.
  }
}

export function castPlay(): void {
  try {
    window.AFMNative?.castPlay?.();
  } catch {
    // Same.
  }
}

export function castPause(): void {
  try {
    window.AFMNative?.castPause?.();
  } catch {
    // Same.
  }
}

export function castSeek(positionMs: number): void {
  try {
    window.AFMNative?.castSeek?.(Math.max(0, Math.round(positionMs)));
  } catch {
    // Same.
  }
}

export function castVolume(volume: number): void {
  try {
    window.AFMNative?.castVolume?.(Math.min(1, Math.max(0, volume)));
  } catch {
    // Same.
  }
}

// --- what the TV fetches ---------------------------------------------------

/*
 * The TV must fetch from the SERVER, never from this phone: the deck's own
 * source may be a local cached file, an asset URL, a blob - none of which a
 * Chromecast can reach. Only serverSession knows which server owns a path and
 * holds a live token for it, and this module sits below the React tree, so
 * the resolver is registered from there - the same seam shape (and the same
 * reason) as core/tauri.ts's remote audio resolver.
 *
 * Deliberately the PLAIN stream: the original file, byte-ranged, which is
 * what makes the TV seekable. The fx chain and stem drops ride the transcode
 * path and cannot follow - a live encode has no ranges for the TV to seek,
 * and casting the rack is a later decision if it is ever wanted.
 */
let streamResolver: ((path: string) => string | null) | null = null;

export function setCastStreamResolver(resolver: ((path: string) => string | null) | null): void {
  streamResolver = resolver;
}

/** What the receiver should be told the bytes are. The codec is off the
 *  library row; anything unknown says mpeg and lets the receiver sniff. */
function contentTypeFor(codec: string | undefined): string {
  const c = (codec ?? '').toLowerCase();
  if (c.includes('flac')) return 'audio/flac';
  if (c.includes('alac') || c.includes('aac') || c.includes('m4a')) return 'audio/mp4';
  if (c.includes('opus') || c.includes('vorbis') || c.includes('ogg')) return 'audio/ogg';
  if (c.includes('wav') || c.includes('pcm')) return 'audio/wav';
  return 'audio/mpeg';
}

/** The stream the TV should fetch for a track, or null for a track that only
 *  exists on this device (a local folder's file has no server to point at). */
export function castMediaFor(
  path: string,
  codec: string | undefined,
): { url: string; contentType: string } | null {
  const url = streamResolver?.(path) ?? null;
  if (!url) return null;
  return { url, contentType: contentTypeFor(codec) };
}
