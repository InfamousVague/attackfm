/** The Spotify account bridge - the hub's /api/spotify endpoints. */

export interface SpotifyStatus {
  connected: boolean;
  displayName: string | null;
  /** What a Connect right now would use: this listener's, else the server's. */
  clientId: string | null;
  /** True when the id came from the hub rather than from this listener. */
  clientIdFromServer?: boolean;
  /** The exact URI the user must register on their Spotify app. */
  redirectUri: string;
}

export interface SpotifyAlbum {
  id: string;
  name: string;
  artist: string;
  url: string;
  tracks: number;
  image: string | null;
  synced: boolean;
}

/** How far a mirrored collection has got. Server-derived, never asserted here. */
export type SyncState =
  | 'new'
  | 'changed'
  | 'synced'
  | 'idle'
  | 'enumerating'
  | 'resolving'
  | 'downloading'
  | 'partial'
  | 'error';

export interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: string;
  url: string;
  tracks: number;
  image: string | null;
  snapshotId: string;
  /**
   * Informational only. The mirror reads playlists as the signed-in user, so
   * private and collaborative ones sync exactly like public ones.
   */
  public: boolean;
  state: SyncState;
  /**
   * Spotify's own list (Discover Weekly, Release Radar, Daily Mix, editorial).
   * Third-party apps are refused these outright, so they cannot be mirrored.
   */
  spotifyOwned?: boolean;
  /** Why this row cannot be tracked, when it cannot. */
  unsupportedReason?: string | null;
  /** True once the server is keeping this collection in step. */
  watch: boolean;
  /** The local playlist this mirrors, once one exists. */
  playlistId: number | null;
  resolved: number;
  queued: number;
  missing: number;
}

/** One mirrored collection's live progress. */
export interface SpotifyMirror {
  key: string;
  kind: 'playlist' | 'album' | 'liked';
  name: string;
  owner: string;
  image: string | null;
  playlistId: number | null;
  watch: boolean;
  state: SyncState;
  error: string;
  total: number;
  resolved: number;
  queued: number;
  missing: number;
  ambiguous: number;
  changed: boolean;
  checkedAt: number;
  syncedAt: number;
}

export interface SpotifySyncStatus {
  phase: 'idle' | 'working';
  totals: {
    watched: number;
    tracks: number;
    resolved: number;
    queued: number;
    missing: number;
    ambiguous: number;
  };
  items: SpotifyMirror[];
}

/** One entry inside a mirrored collection. */
export interface SpotifyMirrorItem {
  uid: string;
  occurrence: number;
  position: number;
  title: string;
  artist: string;
  album: string;
  durationMs: number | null;
  state: 'pending' | 'resolved' | 'queued' | 'missing' | 'ambiguous' | 'unavailable' | 'ignored';
  trackId: number | null;
  method: string;
  note: string;
  attempts: number;
}

export interface SpotifyLibrary {
  albums: SpotifyAlbum[];
  playlists: SpotifyPlaylist[];
}

import type { ServerSession } from '../../src/app/server.ts';
import { serverRequest } from './musicImport.ts';

export async function spotifyStatus(session: ServerSession): Promise<SpotifyStatus> {
  return serverRequest<SpotifyStatus>(session, '/api/spotify/status');
}

/**
 * Starts the login: the hub parks a PKCE state and hands back the authorize
 * URL for the system browser. The redirect returns to the SERVER, not here -
 * the caller polls `spotifyStatus` until it reads connected.
 */
export async function spotifyBeginConnect(
  session: ServerSession,
  clientId: string,
): Promise<{ authorizeUrl: string }> {
  return serverRequest<{ authorizeUrl: string }>(session, '/api/spotify/connect', {
    method: 'POST',
    body: JSON.stringify({ clientId }),
  });
}

export async function spotifyDisconnect(session: ServerSession): Promise<void> {
  await serverRequest(session, '/api/spotify/disconnect', { method: 'POST' });
}

export async function spotifyLibrary(session: ServerSession): Promise<SpotifyLibrary> {
  return serverRequest<SpotifyLibrary>(session, '/api/spotify/library');
}

/**
 * Start (or stop) keeping collections in step. This is the whole subscription:
 * the server enumerates, matches, downloads what is missing and rebuilds the
 * local playlist on its own from here.
 */
export async function spotifyWatch(
  session: ServerSession,
  items: Array<{ key: string; watch: boolean }>,
): Promise<void> {
  await serverRequest(session, '/api/spotify/watch', {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

/** Ask for a pass now. Returns once it has started, not once it has finished. */
export async function spotifySync(
  session: ServerSession,
  keys: string[] = [],
  full = false,
): Promise<void> {
  await serverRequest(session, '/api/spotify/sync', {
    method: 'POST',
    body: JSON.stringify({ keys, full }),
  });
}

/** Where every mirror stands. Read from the server's tables, so it is the same
 *  on every device and survives a restart. */
export async function spotifySyncStatus(session: ServerSession): Promise<SpotifySyncStatus> {
  return serverRequest<SpotifySyncStatus>(session, '/api/spotify/sync');
}

/** The entries inside one mirror - what makes a partial sync inspectable. */
export async function spotifyMirrorItems(
  session: ServerSession,
  key: string,
  state?: SpotifyMirrorItem['state'],
): Promise<{ mirror: SpotifyMirror; items: SpotifyMirrorItem[] }> {
  const query = state ? `?state=${encodeURIComponent(state)}` : '';
  return serverRequest(session, `/api/spotify/mirror/${encodeURIComponent(key)}/items${query}`);
}

/** Clear the backoff on everything this mirror gave up on. */
export async function spotifyMirrorRetry(session: ServerSession, key: string): Promise<void> {
  await serverRequest(session, `/api/spotify/mirror/${encodeURIComponent(key)}/retry`, {
    method: 'POST',
  });
}

/** Stop mirroring. The local playlist and the downloaded files stay. */
export async function spotifyMirrorForget(session: ServerSession, key: string): Promise<void> {
  await serverRequest(session, `/api/spotify/mirror/${encodeURIComponent(key)}/forget`, {
    method: 'POST',
  });
}

/** Records items whose downloads finished so the next read shows them synced. */
export async function spotifyMarkSynced(
  session: ServerSession,
  items: Array<{ key: string; snapshot?: string }>,
): Promise<void> {
  await serverRequest(session, '/api/spotify/synced', {
    method: 'POST',
    body: JSON.stringify({ items: items.map((i) => ({ key: i.key, snapshot: i.snapshot ?? '' })) }),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pending syncs - marked when the download finishes, not when it is queued.
//
// An enqueue that later fails must not leave a permanent "Synced" on an item
// the library never received, so the mark waits for the job to reach `done`.
// The pending map lives in localStorage keyed by job id: the import queue
// itself survives restarts on the Rust side, and this must survive with it.
// ─────────────────────────────────────────────────────────────────────────────

const PENDING_KEY = 'attackfm-spotify-pending-sync';

type PendingMap = Record<string, { key: string; snapshot?: string }>;

function readPending(): PendingMap {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingMap) : {};
  } catch {
    return {};
  }
}

function writePending(map: PendingMap): void {
  try {
    if (Object.keys(map).length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(map));
  } catch {
    // Storage refusing the note only costs an eventual re-sync offer.
  }
}

/** Remembers that a queued job, once done, marks this item synced. */
export function registerPendingSync(jobId: string, key: string, snapshot?: string): void {
  const map = readPending();
  map[jobId] = { key, snapshot };
  writePending(map);
}

/**
 * Settles pending marks against the queue: jobs that finished get marked
 * synced, jobs that errored (or vanished) are dropped so the item stays
 * offered. Called by the downloads provider on every queue update; cheap
 * when nothing is pending. Returns true when something was marked.
 */
export async function settlePendingSyncs(
  session: ServerSession,
  jobs: Array<{ id: string; state: string }>,
): Promise<boolean> {
  const map = readPending();
  const ids = Object.keys(map);
  if (ids.length === 0) return false;

  const byId = new Map(jobs.map((j) => [j.id, j.state]));
  const done: Array<{ key: string; snapshot?: string }> = [];
  let changed = false;
  for (const id of ids) {
    // A `settled:` entry already downloaded - only the mark itself failed
    // last time (signed out, say) - so it retries until the mark lands.
    if (id.startsWith('settled:')) {
      done.push(map[id]!);
      delete map[id];
      changed = true;
      continue;
    }
    const state = byId.get(id);
    if (state === 'done') {
      done.push(map[id]!);
      delete map[id];
      changed = true;
    } else if (state === undefined || state === 'error') {
      // Gone or failed: the item stays unsynced and syncable.
      delete map[id];
      changed = true;
    }
  }
  if (changed) writePending(map);
  if (done.length === 0) return false;
  try {
    await spotifyMarkSynced(session, done);
    return true;
  } catch {
    // Marking failed (signed out, say): put the notes back for next time.
    const restored = readPending();
    for (const item of done) {
      // Job ids are gone from the queue by now; key them by their own name.
      restored[`settled:${item.key}`] = item;
    }
    writePending(restored);
    return false;
  }
}
