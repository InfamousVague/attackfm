//! A crisp cover for an album's name.
//!
//! Embedded art is often a tiny thumbnail that blurs at page size, so the
//! artist page asks the iTunes Search API for a proper cover per album. This
//! module remembers the answers the same way artistImage.ts remembers artist
//! portraits: one keyed map in one localStorage entry, a TTL, negative
//! results cached too, and one in-flight request per album - an album Apple
//! does not know should be asked about once a month, not once per mount.
//!
//! (It used to be one localStorage key per album with no TTL and no negative
//! caching; hydrate() sweeps those legacy keys into the map on first run.)

import { onlineMetadataEnabled } from '../settings/netPrefs.ts';
import { isTauri } from '../core/tauri.ts';

const KEY = 'attackfm-album-art';
const LEGACY_PREFIX = 'attackfm-art:';
/** How long an answer stays good. Covers change even more rarely than artist
 *  photos; a month keeps the cache useful without pinning a miss forever. */
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Entry {
  /** The cover URL, or null when Apple had none. */
  url: string | null;
  at: number;
}

function readAll(): Record<string, Entry> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, Entry>) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, Entry>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // The in-memory map still serves this run.
  }
}

const memory = new Map<string, Entry>();
const inFlight = new Map<string, Promise<string | null>>();
let hydrated = false;

function cacheKey(artist: string, album: string): string {
  return `${artist.trim().toLowerCase()}|${album.trim().toLowerCase()}`;
}

/**
 * Fold the old cache's per-album keys (`attackfm-art:Artist|Album`, bare URL
 * values, positive hits only) into the map, then delete them - they grew one
 * key per album ever viewed, with no ceiling and no expiry.
 */
function sweepLegacy(all: Record<string, Entry>): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(LEGACY_PREFIX)) stale.push(k);
    }
    if (stale.length === 0) return;
    const now = Date.now();
    for (const k of stale) {
      const url = localStorage.getItem(k);
      const bar = k.indexOf('|');
      if (url && bar > LEGACY_PREFIX.length) {
        const artist = k.slice(LEGACY_PREFIX.length, bar);
        const album = k.slice(bar + 1);
        all[cacheKey(artist, album)] ??= { url, at: now };
      }
      localStorage.removeItem(k);
    }
    writeAll(all);
  } catch {
    // Storage refused; the legacy keys wait for a run where it works.
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  const all = readAll();
  sweepLegacy(all);
  const now = Date.now();
  for (const [key, entry] of Object.entries(all)) {
    if (now - entry.at < TTL_MS) memory.set(key, entry);
  }
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

/**
 * A crisp album cover URL from the iTunes Search API, or null - cached,
 * misses included. Concurrent callers for the same album share one request.
 *
 * Art lookup is core UI (the artist page's album covers), not part of the
 * import feature - which is why it lives here rather than in the
 * spotify-import plugin: core must never import from something that can be
 * switched off.
 */
export async function resolveAlbumArt(artist: string, album: string): Promise<string | null> {
  if (!artist.trim() || !album.trim()) return null;
  // The privacy switch: no artist/album names leave for Apple when online
  // metadata lookups are off - the page falls back to library artwork. A
  // gated lookup is not an answer, so nothing is cached here: a month-long
  // miss must not outlive the switch being turned back on.
  if (!isTauri() || !onlineMetadataEnabled()) return null;
  hydrate();
  const key = cacheKey(artist, album);
  const hit = memory.get(key);
  if (hit) return hit.url;
  const already = inFlight.get(key);
  if (already) return already;

  const run = (async () => {
    let url: string | null = null;
    try {
      url = await invoke<string | null>('music_album_art', { artist, album });
    } catch {
      // No network, or an album Apple cannot place. Remembered as a miss so
      // the page stops asking on every mount.
      url = null;
    }
    const entry: Entry = { url, at: Date.now() };
    memory.set(key, entry);
    const all = readAll();
    all[key] = entry;
    writeAll(all);
    inFlight.delete(key);
    return url;
  })();
  inFlight.set(key, run);
  return run;
}
