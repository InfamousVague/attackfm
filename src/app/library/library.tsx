import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  defaultMusicDir,
  ensureDir,
  listAudioFiles,
  loadIndexCache,
  parseTrack,
  pickMusicDir,
  saveIndexCache,
  type Track,
} from '../core/tauri.ts';
import {
  fetchRemoteFavorites,
  hydrateCachedIndex,
  loadCachedIndex,
  requestScan,
  setRemoteFavorite,
  syncLibrary,
  toTrack,
  trackIdFromPath,
  type RemoteTrack,
  type ServerSession,
} from '../server.ts';
import { nudgeSweep } from '../downloads/autoCache.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { pushCarPlayLibrary } from '../player/carplay.ts';

/** Where the chosen music folder lives. Exported because librarySync watches
 *  the same folder - two literals of this key once drifted a rename away from
 *  the sync silently watching the wrong one. */
export const MUSIC_DIR_KEY = 'attackfm-music-dir';
const STORAGE_KEY = MUSIC_DIR_KEY;
const FAVORITES_KEY = 'attackfm-favorites';

// Shown in the browser, where there is no filesystem to name a real default in.
const DISPLAY_FALLBACK = '~/Music/AttackFM';

/** Which library the app is showing. */
export type LibrarySource = 'local' | 'server';

interface LibraryContextValue {
  /** Which library is in effect - a folder on this machine, or a server. */
  source: LibrarySource;
  /** Where music is stored. The resolved default until the user picks another. */
  musicDir: string;
  /** True while the default is still being resolved from the OS. */
  loading: boolean;
  /** True when the folder is the OS default rather than a chosen one. */
  isDefault: boolean;
  /** Opens the folder picker and adopts the chosen directory. */
  choose: () => Promise<void>;
  /** Returns to the OS default location. */
  reset: () => Promise<void>;
  /** Every track found under the music folder, refreshed on each scan. */
  tracks: Track[];
  /**
   * Tracks the collector downloaded that nobody has adopted yet - held OFF the
   * main shelves so the library stays what its people chose, and shown only on
   * the owning account's "For you" surface. Always empty for a local library.
   */
  forYou: Track[];
  /** The favourited tracks that are present in the current library, newest first. */
  favoriteTracks: Track[];
  /** Whether a track (by path) is favourited. */
  isFavorite: (path: string) => boolean;
  /** Adds or removes a track from favourites. */
  toggleFavorite: (path: string) => void;
  /** True while the folder is being walked and tags are being read. */
  scanning: boolean;
  /** True while the background indexer is still reading tags. */
  indexing: boolean;
  /** How many files the indexer has read so far this pass. */
  indexed: number;
  /** How many files the current pass has to read in total. */
  indexTotal: number;
  /** Re-walks the current folder and rebuilds the track list. */
  rescan: () => Promise<void>;
  /** The last sync or scan failure, for the settings pane to show. Null when well. */
  error: string | null;
}

const LibraryContext = createContext<LibraryContextValue | null>(null);

// How many files' tags to read before yielding. Small enough that playback and
// scrolling stay smooth while the indexer runs, large enough to get through a
// big library in reasonable time.
const INDEX_BATCH = 12;

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

// Favourites persist as an ordered list of track paths, newest first.
function readFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The library, from whichever source is in effect.
 *
 * The two sources are separate components rather than branches inside one, so
 * that switching between them remounts everything below - which is what should
 * happen. A queue, a playing track and a scroll position all belong to the
 * library they came from, and carrying them across a source change would leave
 * the app holding rows that no longer resolve.
 */
export function LibraryProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  return session ? (
    <RemoteLibrary key={session.url} session={session}>
      {children}
    </RemoteLibrary>
  ) : (
    <LocalLibrary>{children}</LocalLibrary>
  );
}

/**
 * Owns the music-storage location. It starts from a stored choice if there is
 * one, otherwise the OS default (an AttackFM folder under ~/Music), which it
 * creates on first run. A chosen folder persists to localStorage; resetting
 * clears it and falls back to the default again.
 */
function LocalLibrary({ children }: { children: ReactNode }) {
  const [custom, setCustom] = useState<string | null>(readStored);
  const [fallback, setFallback] = useState<string | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [indexed, setIndexed] = useState(0);
  const [indexTotal, setIndexTotal] = useState(0);
  // Favourite track paths, newest first.
  const [favorites, setFavorites] = useState<string[]>(readFavorites);

  const musicDir = custom ?? fallback ?? DISPLAY_FALLBACK;
  const resolving = custom === null && fallback === null;

  // The bar and table stand as skeletons only while there is nothing settled to
  // show yet - once the first rows land (from cache or the first batch) the real
  // list takes over and the rest streams in behind it.
  const scanning = indexing && tracks.length === 0;

  // The artwork object URLs are revoked before each index pass so a reload does
  // not leak the previous set.
  const artworkUrls = useRef<string[]>([]);
  // A token that identifies the current pass, so a folder change or a rescan can
  // abandon an in-flight one instead of two passes writing over each other.
  const passToken = useRef(0);

  const index = useCallback(async (dir: string) => {
    const pass = (passToken.current += 1);
    const alive = () => pass === passToken.current;

    setIndexing(true);
    setIndexed(0);

    // Show the cached list at once, so a relaunch is instant rather than blank
    // while every tag is re-read.
    const cached = await loadIndexCache(dir);
    if (!alive()) return;
    const cachedByPath = new Map(cached.map((t) => [t.path, t] as const));

    // The folder walk is the authoritative list; the cache only seeds it.
    const files = await listAudioFiles(dir);
    if (!alive()) return;

    for (const url of artworkUrls.current) URL.revokeObjectURL(url);
    artworkUrls.current = [];

    // Seed from cache in the folder's order, dropping any cached rows whose
    // files are gone. New files simply appear as the indexer reaches them.
    const collected = new Map<string, Track>();
    for (const file of files) {
      const hit = cachedByPath.get(file);
      if (hit) collected.set(file, hit);
    }
    const ordered = () => files.map((f) => collected.get(f)).filter((t): t is Track => t !== undefined);
    setTracks(ordered());
    setIndexTotal(files.length);

    // Read tags a batch at a time, merging each in and yielding between batches.
    let done = 0;
    for (let i = 0; i < files.length; i += INDEX_BATCH) {
      if (!alive()) return;
      const slice = files.slice(i, i + INDEX_BATCH);
      const parsed = await Promise.all(slice.map((file) => parseTrack(file)));
      if (!alive()) return;
      for (const track of parsed) {
        if (!track) continue;
        collected.set(track.path, track);
        if (track.artwork) artworkUrls.current.push(track.artwork);
      }
      done += slice.length;
      setIndexed(Math.min(done, files.length));
      setTracks(ordered());
      // Hand the thread back so the UI and audio stay responsive mid-index.
      await new Promise((resolve) => setTimeout(resolve, 15));
    }

    if (!alive()) return;
    const finalTracks = ordered();
    setTracks(finalTracks);
    setIndexing(false);
    void saveIndexCache(dir, finalTracks);
  }, []);

  // Resolve the default once, so a first run has a real folder to point at even
  // before the user opens settings. Whichever folder is in effect - the stored
  // choice or the default - is created if it is not already there.
  useEffect(() => {
    let live = true;
    void (async () => {
      const dir = await defaultMusicDir();
      if (!live) return;
      setFallback(dir ?? DISPLAY_FALLBACK);
      const stored = readStored();
      const inUse = stored ?? dir;
      if (inUse) await ensureDir(inUse);
    })();
    return () => {
      live = false;
    };
  }, []);

  // Scan whenever the folder in effect changes (and once it is first resolved).
  useEffect(() => {
    if (resolving) return;
    void index(musicDir);
  }, [musicDir, resolving, index]);

  const value = useMemo<LibraryContextValue>(() => {
    // Only favourites that are still in the library, kept in the saved order.
    const byPath = new Map(tracks.map((t) => [t.path, t] as const));
    const favoriteTracks = favorites.map((p) => byPath.get(p)).filter((t): t is Track => t !== undefined);
    return {
      source: 'local',
      musicDir,
      loading: resolving,
      isDefault: custom === null,
      tracks,
      // A local folder has no collector: everything in it was put there.
      forYou: [],
      favoriteTracks,
      isFavorite: (path: string) => favorites.includes(path),
      toggleFavorite: (path: string) =>
        setFavorites((prev) => {
          const next = prev.includes(path) ? prev.filter((p) => p !== path) : [path, ...prev];
          try {
            localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
          } catch {
            // Storage refused: the heart still applies for this run.
          }
          return next;
        }),
      scanning,
      indexing,
      indexed,
      indexTotal,
      rescan: () => index(musicDir),
      error: null,
      choose: async () => {
        const picked = await pickMusicDir(musicDir);
        if (!picked) return;
        await ensureDir(picked);
        setCustom(picked);
        try {
          localStorage.setItem(STORAGE_KEY, picked);
        } catch {
          // The pick still applies for this run; next launch asks again.
        }
      },
      reset: async () => {
        setCustom(null);
        try {
          localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Same story as choose(): the reset holds for this run.
        }
        const dir = await defaultMusicDir();
        if (dir) await ensureDir(dir);
      },
    };
  }, [musicDir, resolving, custom, tracks, scanning, index, favorites, indexing, indexed, indexTotal]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

/**
 * The library as it lives on a server.
 *
 * The shape it exposes is deliberately identical to the local one, so no
 * consumer - the table, the search, the showcase, the player - can tell which
 * it is looking at. What differs is only how the list is obtained: a delta sync
 * against a revision the client remembers, seeded from a cached index so a
 * relaunch renders before the network answers.
 */
function RemoteLibrary({ session, children }: { session: ServerSession; children: ReactNode }) {
  // Seeded from the in-memory index (instant within a run); the disk copy in
  // IndexedDB arrives via hydrate below, still ahead of the first network
  // answer, so a relaunch renders the library before the server is asked.
  const [remote, setRemote] = useState<RemoteTrack[]>(() => loadCachedIndex(session.url).tracks);
  // Blocks the first sync until the disk index has been read: syncing first
  // would ask "everything since rev 0" and re-download the whole library on
  // every launch, which is exactly what the cache exists to prevent.
  const [hydrated, setHydrated] = useState(false);
  const [syncing, setSyncing] = useState(true);
  const [synced, setSynced] = useState(0);
  const [favorites, setFavorites] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);

  const passToken = useRef(0);

  const sync = useCallback(
    async (options: { silent?: boolean } = {}) => {
      const pass = (passToken.current += 1);
      const alive = () => pass === passToken.current;
      // A silent pass is the background heartbeat: it folds new rows in
      // without raising the syncing strip, so the pill only shows for syncs
      // somebody asked for (launch, rescan) rather than flashing every half
      // minute over a settled library.
      if (!options.silent) {
        setSyncing(true);
        setError(null);
      }
      try {
        const { tracks, changed } = await syncLibrary(session, {
          onProgress: (count) => {
            if (alive()) setSynced(count);
          },
        });
        if (!alive()) return;
        // A quiet pass keeps the old array identity, so nothing under the
        // library context re-renders and CarPlay is not re-pushed - the
        // heartbeat's usual answer becomes free. The one exception: the very
        // first pass adopts the hydrated rows even when the server has
        // nothing newer, because state and index may have loaded separately.
        setRemote((prev) => (changed || prev.length !== tracks.length ? tracks : prev));
      } catch (err) {
        if (!alive()) return;
        if (options.silent) return;
        // The cached rows stay on screen: a library you cannot reach right now is
        // better company than an empty one, and the error says why it is stale.
        setError(err instanceof Error ? err.message : 'Could not reach the server');
      } finally {
        // NOT alive-gated: if this pass outlived a token bump (the 30s
        // heartbeat overtaking a stalled first sync), the pass that SET
        // syncing is still the only one that will ever clear it - gating on
        // aliveness latched the strip (and the skeletons behind it) on
        // permanently.
        if (!options.silent) setSyncing(false);
      }
    },
    [session],
  );

  useEffect(() => {
    let live = true;
    void hydrateCachedIndex(session.url)
      .then((index) => {
        if (!live) return;
        if (index.tracks.length > 0) setRemote(index.tracks);
      })
      .catch(() => {
        // A cache that cannot be read is a slow start, never a stuck one.
      })
      .finally(() => {
        // UNCONDITIONAL: hydrated gates the first sync and the heartbeat, so
        // a hydrate that hangs or dies must still open the gate - the app
        // wedged exactly here once, skeletons forever behind a green dot.
        if (live) setHydrated(true);
      });
    return () => {
      live = false;
    };
  }, [session.url]);

  useEffect(() => {
    if (hydrated) void sync();
  }, [hydrated, sync]);

  // The heartbeat that keeps every signed-in device converging on the same
  // library without anyone pressing rescan: a delta poll, so a settled library
  // costs one tiny request and an upload landing anywhere shows up everywhere
  // within the half minute.
  useEffect(() => {
    if (!hydrated) return;
    const interval = window.setInterval(() => {
      void sync({ silent: true });
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [hydrated, sync]);

  // Favourites live on the server, so they follow the account between devices.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const ids = await fetchRemoteFavorites(session);
        if (live) setFavorites(ids);
      } catch {
        // Not fatal: the library still plays, hearts just show empty until the
        // next successful fetch.
      }
    })();
    return () => {
      live = false;
    };
  }, [session]);

  const mapped = useMemo(
    // Newest first, matching the order the table opens on for a local library.
    () => remote.map((r) => toTrack(session, r)).sort((a, b) => b.addedAt - a.addedAt),
    [remote, session],
  );
  // The quarantine line: collector downloads stay off the main shelves until
  // someone adopts them (a listen-through or a heart flips curatorPromoted).
  // Split here, once, so every surface downstream - table, search, shelves,
  // CarPlay - inherits the rule without knowing it exists.
  // AttackFM is a music app. A server may still hold rows marked as book
  // sections - a hub that ran the audiobook feature keeps its files - and they
  // are filtered out here, once, so no shelf, mix, search or queue downstream
  // has to know they exist.
  const music = useMemo(() => mapped.filter((t) => t.kind !== 'book'), [mapped]);
  const tracks = useMemo(
    () => music.filter((t) => t.curatorUserId == null || t.curatorPromoted),
    [music],
  );
  const forYou = useMemo(
    () => music.filter((t) => t.curatorUserId != null && !t.curatorPromoted),
    [music],
  );

  // The car screen mirrors whatever this device has synced: every delta and
  // every heart re-pushes. A no-op everywhere but iOS, where the native side
  // rebuilds its templates from this.
  useEffect(() => {
    void pushCarPlayLibrary(tracks, favorites);
  }, [tracks, favorites]);

  const value = useMemo<LibraryContextValue>(() => {
    const favoriteSet = new Set(favorites);
    const byId = new Map(tracks.map((t) => [trackIdFromPath(t.path), t] as const));
    const favoriteTracks = favorites
      .map((id) => byId.get(id))
      .filter((t): t is Track => t !== undefined);

    return {
      source: 'server',
      // What the settings pane names as the library's location.
      musicDir: session.url,
      loading: false,
      isDefault: false,
      tracks,
      forYou,
      favoriteTracks,
      isFavorite: (path: string) => {
        const id = trackIdFromPath(path);
        return id !== null && favoriteSet.has(id);
      },
      toggleFavorite: (path: string) => {
        const id = trackIdFromPath(path);
        if (id === null) return;
        const nowFavorite = !favoriteSet.has(id);
        // Optimistic: the heart answers the press at once, and a server that
        // refuses puts it back.
        setFavorites((prev) => (nowFavorite ? [id, ...prev.filter((f) => f !== id)] : prev.filter((f) => f !== id)));
        void setRemoteFavorite(session, id, nowFavorite).catch(() => {
          setFavorites((prev) => (nowFavorite ? prev.filter((f) => f !== id) : [id, ...prev]));
        });
        // A heart is a stated wish, and the device cache holds liked songs -
        // so it acts on the wish now rather than at the next scheduled sweep.
        // Both directions: hearting downloads soon, unhearting frees the room.
        nudgeSweep();
      },
      scanning: syncing && tracks.length === 0,
      indexing: syncing,
      indexed: synced,
      indexTotal: Math.max(synced, tracks.length),
      // A rescan on a server means two things: ask the box to re-walk its own
      // folder, then pull whatever that turned up.
      rescan: async () => {
        await requestScan(session).catch(() => {});
        await sync();
      },
      error,
      // A server library has no folder to pick, and nothing to reset to.
      choose: async () => {},
      reset: async () => {},
    };
  }, [session, tracks, forYou, favorites, syncing, synced, sync, error]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary must be used within a LibraryProvider');
  return value;
}
