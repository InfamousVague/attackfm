/** The Spotify account bridge, mirroring the Rust `spotify.rs` commands. */

export interface SpotifyStatus {
  connected: boolean;
  displayName: string | null;
  clientId: string | null;
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

export interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: string;
  url: string;
  tracks: number;
  image: string | null;
  snapshotId: string;
  /** False for private and collaborative playlists, which the public-page importer cannot fetch. */
  public: boolean;
  /** "new" (never synced), "changed" (snapshot moved), or "synced". */
  state: 'new' | 'changed' | 'synced';
}

export interface SpotifyLibrary {
  albums: SpotifyAlbum[];
  playlists: SpotifyPlaylist[];
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

export async function spotifyStatus(): Promise<SpotifyStatus> {
  return invoke<SpotifyStatus>('spotify_status');
}

/**
 * The whole login roundtrip: opens the browser and resolves once the user
 * has finished consenting (or five minutes pass). Long-running by design.
 */
export async function spotifyConnect(clientId: string): Promise<SpotifyStatus> {
  return invoke<SpotifyStatus>('spotify_connect', { clientId });
}

export async function spotifyDisconnect(): Promise<void> {
  await invoke('spotify_disconnect');
}

export async function spotifyLibrary(): Promise<SpotifyLibrary> {
  return invoke<SpotifyLibrary>('spotify_library');
}

/** Records items whose downloads finished so the next read shows them synced. */
export async function spotifyMarkSynced(
  items: Array<{ key: string; snapshot?: string }>,
): Promise<void> {
  await invoke('spotify_mark_synced', {
    items: items.map((i) => ({ key: i.key, snapshot: i.snapshot ?? '' })),
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
    await spotifyMarkSynced(done);
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
