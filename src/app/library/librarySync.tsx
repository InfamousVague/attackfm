import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { defaultMusicDir, listAudioFiles, parseTrackMeta } from '../core/tauri.ts';
import { fetchMissingTracks, uploadFile, ServerError, type SyncCheckEntry } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { MUSIC_DIR_KEY, useLibrary } from './library.tsx';
import { hasLocalLibrary } from '../core/platform.ts';

/**
 * The hub model, up-sync half: whatever lands in this machine's music folder -
 * an import, a drag from Finder, anything - belongs on the server, and from
 * there in every device's catalog. This provider owns that reconciliation:
 * walk the folder, ask the server which of these tracks it lacks (by tags,
 * so re-syncing is idempotent even though the server suffixes name
 * collisions), upload exactly those, then pull the catalog so the new rows
 * appear where the user is looking.
 *
 * Runs on connect, after every finished download, and on demand from
 * Settings. Phones sit this out entirely: they have no local folder to sync
 * (hasLocalLibrary is false there by design).
 */

const KNOWN_KEY_PREFIX = 'attackfm-sync-known:';
const CHECK_BATCH = 500;

export interface LibrarySyncStatus {
  state: 'idle' | 'checking' | 'uploading' | 'error' | 'unsupported';
  /** Uploads finished this pass. */
  done: number;
  /** Uploads this pass set out to make. */
  total: number;
  /** The file currently going up, for the settings row. */
  current: string | null;
  error: string | null;
  /** When the last pass finished cleanly, epoch ms. */
  lastSyncedAt: number | null;
}

interface LibrarySyncContextValue {
  status: LibrarySyncStatus;
  /** Starts a pass unless one is running. A no-op with no server connected. */
  syncNow: () => void;
}

const IDLE: LibrarySyncStatus = {
  state: 'idle',
  done: 0,
  total: 0,
  current: null,
  error: null,
  lastSyncedAt: null,
};

const LibrarySyncContext = createContext<LibrarySyncContextValue | null>(null);

// Files already reconciled with this server, so later passes only read what
// is new. Keyed `${path}|${size}` - an edited file re-offers itself.
function readKnown(serverUrl: string): Set<string> {
  try {
    const raw = localStorage.getItem(KNOWN_KEY_PREFIX + serverUrl);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : []);
  } catch {
    return new Set();
  }
}

function persistKnown(serverUrl: string, known: Set<string>): void {
  try {
    localStorage.setItem(KNOWN_KEY_PREFIX + serverUrl, JSON.stringify([...known]));
  } catch {
    // The cache only saves re-reading tags; losing it costs time, not music.
  }
}

export function LibrarySyncProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const { rescan, source } = useLibrary();
  const [status, setStatus] = useState<LibrarySyncStatus>(IDLE);

  const sessionRef = useRef(session);
  sessionRef.current = session;
  const rescanRef = useRef(rescan);
  rescanRef.current = rescan;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const running = useRef(false);
  // A trigger that lands mid-pass is not noise - it is usually the NEXT album
  // finishing while the current pass uploads. The pass walks the folder once
  // at its start, so anything landing after that walk needs a fresh pass:
  // remembered here, run when the current one ends.
  const pending = useRef(false);
  // Set once a pass hits 404 on the precheck: the server predates the sync
  // API, and retrying every trigger would just spam a box that cannot answer.
  const unsupported = useRef(false);
  // Flipped on unmount. A connect or disconnect remounts everything under the
  // LibraryProvider - this provider included - and a pass from the previous
  // life must stop at its next checkpoint rather than keep uploading against
  // a server the user just left.
  const dead = useRef(false);
  useEffect(() => {
    dead.current = false;
    return () => {
      dead.current = true;
    };
  }, []);

  const syncNow = useCallback(() => {
    const session = sessionRef.current;
    if (!session || unsupported.current || !hasLocalLibrary) return;
    if (running.current) {
      pending.current = true;
      return;
    }
    running.current = true;

    void (async () => {
      try {
        setStatus((s) => ({ ...s, state: 'checking', done: 0, total: 0, current: null, error: null }));

        const dir = localStorage.getItem(MUSIC_DIR_KEY) ?? (await defaultMusicDir());
        if (!dir) {
          setStatus((s) => ({ ...s, state: 'idle' }));
          return;
        }
        const files = await listAudioFiles(dir);
        const known = readKnown(session.url);

        // Read tags only off files this server has not been asked about.
        const fresh: { path: string; entry: SyncCheckEntry; key: string; size: number }[] = [];
        for (const path of files) {
          if (dead.current) return;
          const meta = await parseTrackMeta(path);
          if (!meta) continue;
          const key = `${path}|${meta.size}`;
          if (known.has(key)) continue;
          fresh.push({
            path,
            key,
            size: meta.size,
            entry: { title: meta.title, artist: meta.artist, album: meta.album, duration: meta.duration },
          });
        }
        if (fresh.length === 0) {
          setStatus((s) => ({ ...s, state: 'idle', lastSyncedAt: Date.now() }));
          return;
        }

        // Which of the fresh files the server lacks, in request batches.
        const missing: typeof fresh = [];
        for (let i = 0; i < fresh.length; i += CHECK_BATCH) {
          if (dead.current) return;
          const slice = fresh.slice(i, i + CHECK_BATCH);
          const gaps = await fetchMissingTracks(session, slice.map((f) => f.entry));
          slice.forEach((f, j) => {
            if (gaps.has(j)) missing.push(f);
            else {
              // Already on the server (this rip or another): remembered, never
              // offered again.
              known.add(f.key);
            }
          });
        }
        persistKnown(session.url, known);

        if (missing.length === 0) {
          setStatus((s) => ({ ...s, state: 'idle', lastSyncedAt: Date.now() }));
          return;
        }

        setStatus((s) => ({ ...s, state: 'uploading', done: 0, total: missing.length }));
        const fs = await import('@tauri-apps/plugin-fs');
        let sent = 0;
        let failedAny = false;
        // One representative per tag identity within the pass: the server
        // dedupes nothing at finish (it suffixes name collisions), so a rip
        // present twice locally would otherwise land twice remotely.
        const sentIdentity = new Set<string>();
        const identityOf = (e: SyncCheckEntry) =>
          `${e.title}\u{1}${e.artist}\u{1}${e.album}`.toLowerCase();
        for (const item of missing) {
          if (dead.current) return;
          if (sentIdentity.has(identityOf(item.entry))) continue;
          const name = item.path.split(/[\\/]/).pop() ?? 'track';
          setStatus((s) => ({ ...s, current: name }));
          try {
            // Still moving means still being written - an import mid-run, a
            // copy in flight. A truncated FLAC parses with complete head tags
            // and its truncated upload would then BLOCK the finished file
            // (same tags, same claimed duration), so nothing goes up until
            // its size has held still since the walk. Skipped, not failed:
            // the next pass offers it again.
            const stat = await fs.stat(item.path).catch(() => null);
            if (!stat || stat.size !== item.size) continue;
            // Re-asked one file at a time at the moment it matters: the batch
            // answer above ages across a long upload phase, and another
            // device syncing the same album (the hub model's normal day) may
            // have landed this track since.
            const stillMissing = await fetchMissingTracks(session, [item.entry]);
            if (!stillMissing.has(0)) {
              known.add(item.key);
              persistKnown(session.url, known);
              continue;
            }
            const bytes = await fs.readFile(item.path);
            await uploadFile(session, {
              name,
              size: bytes.byteLength,
              slice: async (start, end) => bytes.slice(start, end),
            });
            sentIdentity.add(identityOf(item.entry));
            known.add(item.key);
            persistKnown(session.url, known);
            sent += 1;
            setStatus((s) => ({ ...s, done: sent }));
          } catch {
            // Left un-known: the next pass offers it again.
            failedAny = true;
          }
        }

        // The server indexed each landing; one pull makes them visible here.
        if (sent > 0 && sourceRef.current === 'server') void rescanRef.current();

        setStatus((s) => ({
          ...s,
          state: failedAny ? 'error' : 'idle',
          current: null,
          error: failedAny ? 'Some files did not upload; they will retry on the next sync.' : null,
          lastSyncedAt: Date.now(),
        }));
      } catch (err) {
        if (err instanceof ServerError && err.status === 404) {
          unsupported.current = true;
          setStatus((s) => ({ ...s, state: 'unsupported', current: null, error: null }));
        } else {
          setStatus((s) => ({
            ...s,
            state: 'error',
            current: null,
            error: err instanceof Error ? err.message : 'Sync failed',
          }));
        }
      } finally {
        running.current = false;
        if (pending.current) {
          pending.current = false;
          syncNow();
        }
      }
    })();
  }, []);

  // A connect is the moment the folder and the server most likely disagree -
  // everything downloaded while signed out is sitting here unsent. The small
  // delay lets the catalog sync land first so the app opens on music, not on
  // an upload spinner.
  // Keyed on the URL, not the session object: a token renewal mints a fresh
  // session for the same server, and neither deserves a fresh folder walk
  // nor a reset of the "this server cannot sync" verdict.
  const serverUrl = session?.url ?? null;
  useEffect(() => {
    if (!serverUrl || !hasLocalLibrary) return;
    unsupported.current = false;
    const timer = window.setTimeout(syncNow, 3000);
    return () => window.clearTimeout(timer);
  }, [serverUrl, syncNow]);

  const value = useMemo<LibrarySyncContextValue>(() => ({ status, syncNow }), [status, syncNow]);

  return <LibrarySyncContext.Provider value={value}>{children}</LibrarySyncContext.Provider>;
}

export function useLibrarySync(): LibrarySyncContextValue {
  const value = useContext(LibrarySyncContext);
  if (!value) throw new Error('useLibrarySync must be used within a LibrarySyncProvider');
  return value;
}
