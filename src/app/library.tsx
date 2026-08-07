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
} from './tauri.ts';

const STORAGE_KEY = 'attackfm-music-dir';
const FAVORITES_KEY = 'attackfm-favorites';

// Shown in the browser, where there is no filesystem to name a real default in.
const DISPLAY_FALLBACK = '~/Music/AttackFM';

interface LibraryContextValue {
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
 * Owns the music-storage location. It starts from a stored choice if there is
 * one, otherwise the OS default (an AttackFM folder under ~/Music), which it
 * creates on first run. A chosen folder persists to localStorage; resetting
 * clears it and falls back to the default again.
 */
export function LibraryProvider({ children }: { children: ReactNode }) {
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
      musicDir,
      loading: resolving,
      isDefault: custom === null,
      tracks,
      favoriteTracks,
      isFavorite: (path: string) => favorites.includes(path),
      toggleFavorite: (path: string) =>
        setFavorites((prev) => {
          const next = prev.includes(path) ? prev.filter((p) => p !== path) : [path, ...prev];
          localStorage.setItem(FAVORITES_KEY, JSON.stringify(next));
          return next;
        }),
      scanning,
      indexing,
      indexed,
      indexTotal,
      rescan: () => index(musicDir),
      choose: async () => {
        const picked = await pickMusicDir(musicDir);
        if (!picked) return;
        await ensureDir(picked);
        setCustom(picked);
        localStorage.setItem(STORAGE_KEY, picked);
      },
      reset: async () => {
        setCustom(null);
        localStorage.removeItem(STORAGE_KEY);
        const dir = await defaultMusicDir();
        if (dir) await ensureDir(dir);
      },
    };
  }, [musicDir, resolving, custom, tracks, scanning, index, favorites, indexing, indexed, indexTotal]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary(): LibraryContextValue {
  const value = useContext(LibraryContext);
  if (!value) throw new Error('useLibrary must be used within a LibraryProvider');
  return value;
}

