import { useCallback, useSyncExternalStore } from 'react';
import { trackIdFromPath } from '../api/library.ts';
import type { Track } from '../core/tauri.ts';

/**
 * What the listener said no to THIS SITTING - the ledger every dealt surface
 * reads before it draws a card.
 *
 * A no has to be visible as having been heard: the card leaves, a toast
 * confirms, and the song never comes straight back. The server writes the
 * rejection memory and the next fetch honours it - but the feed already on
 * screen was dealt before the no, and a re-render off that stale reply would
 * put the song right back under the thumb that just refused it. This set is
 * the gap-filler: the DJ's set cards, the Date deck and the station's refill
 * all filter through it, so a rejected song cannot re-render from anything
 * fetched before the no, and a rejected artist's other cards go with it.
 *
 * Per session on purpose. The server is the memory (a track for ninety
 * days, an artist for thirty); this only has to outlive the feed that was
 * already in hand, and a set that persisted would drift from the server's
 * own expiry with no way to reconcile.
 *
 * Keyed by three kinds of thing, since a no lands on a song by library id,
 * on a preview date by catalogue id, or on an artist by name:
 *   `track:<id>`, `ext:<extId>`, `artist:<lowercased name>`.
 */
const keys = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

export const PREVIEW_PREFIX = 'preview:';

export function trackKey(trackId: number): string {
  return `track:${trackId}`;
}

export function extKey(extId: string): string {
  return `ext:${extId}`;
}

export function artistKey(artist: string): string {
  return `artist:${artist.trim().toLowerCase()}`;
}

/** Write a no down. Idempotent; notifies only when something changed. */
export function noteNo(key: string): void {
  if (keys.has(key)) return;
  keys.add(key);
  version += 1;
  for (const fn of listeners) fn();
}

export function saidNo(key: string): boolean {
  return keys.has(key);
}

/**
 * Whether this song, or its artist, was refused this sitting. Reads the
 * library id off an `afm://` path and the catalogue id off a `preview:`
 * one, so one predicate serves every deck.
 */
export function saidNoTo(track: Pick<Track, 'path' | 'artist'>): boolean {
  if (keys.size === 0) return false;
  if (track.artist.trim() && keys.has(artistKey(track.artist))) return true;
  const id = trackIdFromPath(track.path);
  if (id !== null && keys.has(trackKey(id))) return true;
  if (track.path.startsWith(PREVIEW_PREFIX) && keys.has(extKey(track.path.slice(PREVIEW_PREFIX.length)))) {
    return true;
  }
  return false;
}

/** Bumped on every write - the snapshot a subscriber compares. */
export function saidNoVersion(): number {
  return version;
}

export function subscribeSaidNo(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * The predicate as a hook: a new function identity on every write, so a
 * memo keyed on it recomputes exactly when the ledger changed and not
 * otherwise. Callers filter their rows through it.
 */
export function useSaidNo(): (track: Pick<Track, 'path' | 'artist'>) => boolean {
  const v = useSyncExternalStore(subscribeSaidNo, saidNoVersion, saidNoVersion);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- v is the ledger's version; the predicate reads the live set
  return useCallback((track: Pick<Track, 'path' | 'artist'>) => saidNoTo(track), [v]);
}

/** For a probe or a test: forget everything. Never called by the app. */
export function resetSaidNo(): void {
  keys.clear();
  version += 1;
  for (const fn of listeners) fn();
}
