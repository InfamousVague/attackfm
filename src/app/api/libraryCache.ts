import type { RemoteTrack } from './library.ts';

// --- sync state -----------------------------------------------------------

/**
 * The cached index, so a relaunch shows the library before the network answers
 * - the remote counterpart of the on-disk index cache the local scanner keeps.
 * Stored per server URL, so switching servers does not blend two libraries.
 */
const CACHE_PREFIX = 'attackfm-remote-index:';

interface CachedIndex {
  rev: number;
  tracks: RemoteTrack[];
}

function cacheKey(url: string): string {
  return `${CACHE_PREFIX}${url}`;
}

// The index lives in three places, cheapest first:
//
//  - a module-level Map, so every sync pass inside one run reads memory - the
//    heartbeat must never depend on persistence working;
//  - IndexedDB, whose quota holds libraries localStorage cannot. The old
//    localStorage copy hit WKWebView's ~5MB ceiling somewhere around 1,500
//    lyric-bearing tracks, after which the save failed SILENTLY, rev never
//    persisted, and every launch - and, worse, every 30-second heartbeat -
//    re-downloaded the entire library JSON. That was most of "the app got
//    slow once the library got big";
//  - the legacy localStorage key, read once for migration and then deleted,
//    which also hands its quota back to the small caches that still live
//    there (sessions, feed cards, search recents).
const memIndex = new Map<string, CachedIndex>();

const IDB_NAME = 'attackfm';
const IDB_STORE = 'remoteIndex';

function openIndexDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function idbRead(url: string): Promise<CachedIndex | null> {
  const db = await openIndexDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(url);
      req.onsuccess = () => {
        const parsed = req.result as Partial<CachedIndex> | undefined;
        resolve(
          parsed && typeof parsed.rev === 'number' && Array.isArray(parsed.tracks)
            ? { rev: parsed.rev, tracks: parsed.tracks }
            : null,
        );
      };
      req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'));
    });
  } finally {
    db.close();
  }
}

async function idbWrite(url: string, index: CachedIndex | null): Promise<void> {
  const db = await openIndexDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const store = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE);
      const req = index ? store.put(index, url) : store.delete(url);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('indexedDB write failed'));
    });
  } finally {
    db.close();
  }
}

/** The in-memory index; whatever hydrate() has seeded, or empty. */
export function loadCachedIndex(url: string): CachedIndex {
  return memIndex.get(url) ?? { rev: 0, tracks: [] };
}

/**
 * Fills the in-memory index from disk - IndexedDB, or the legacy localStorage
 * copy once, migrating it - and returns it. Call before the first sync so the
 * first delta asks "since rev N", not "everything".
 */
export async function hydrateCachedIndex(url: string): Promise<CachedIndex> {
  const inMemory = memIndex.get(url);
  if (inMemory) return inMemory;
  let index: CachedIndex | null = null;
  try {
    index = await idbRead(url);
  } catch {
    // A store that will not open costs the fast start, not the library.
  }
  if (index) {
    // IndexedDB is authoritative now; a legacy localStorage copy left behind
    // (a migration interrupted mid-write) is just quota spent twice.
    try {
      localStorage.removeItem(cacheKey(url));
    } catch {
      // Not worth anything if it will not go.
    }
  }
  if (!index) {
    try {
      const raw = localStorage.getItem(cacheKey(url));
      const parsed = raw ? (JSON.parse(raw) as Partial<CachedIndex>) : null;
      if (parsed && typeof parsed.rev === 'number' && Array.isArray(parsed.tracks)) {
        index = { rev: parsed.rev, tracks: parsed.tracks };
        void idbWrite(url, index).then(() => localStorage.removeItem(cacheKey(url))).catch(() => {});
      }
    } catch {
      // Unreadable legacy cache: start from zero, same as a fresh install.
    }
  }
  const settled = index ?? { rev: 0, tracks: [] };
  memIndex.set(url, settled);
  return settled;
}

export function saveCachedIndex(url: string, index: CachedIndex): void {
  memIndex.set(url, index);
  void idbWrite(url, index).catch(() => {
    // Persistence failing still leaves the memory copy carrying this run.
  });
}
