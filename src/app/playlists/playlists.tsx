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
import {
  addPlaylistWant,
  createRemotePlaylist,
  deleteRemotePlaylist,
  fetchRemotePlaylists,
  playlistCoverUrl,
  remotePath,
  removePlaylistCover,
  removePlaylistWant,
  settlePlaylistWant,
  trackIdFromPath,
  updateRemotePlaylist,
  uploadPlaylistCover,
  type PlaylistWant,
  type RemotePlaylist,
  type ServerSession,
} from '../server.ts';
import { fold, titleKey } from '../library/owned.ts';
import {
  forgetMeta,
  metaFor,
  metaKey,
  metaSnapshot,
  setMeta as setStoredMeta,
  subscribeMeta,
} from './playlistMeta.ts';
import { useSyncExternalStore } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { readFeedCache, writeFeedCache } from '../library/feedCache.ts';

const STORAGE_KEY = 'attackfm-playlists';

/**
 * A user playlist as the app reads it: a name over an ordered list of track
 * paths. Paths rather than track objects for the same reason favourites store
 * paths - the library re-resolves them each render, so a track going missing
 * never leaves a playlist holding dead rows.
 */
export interface Playlist {
  id: string;
  name: string;
  paths: string[];
  createdAt: number;
  /** What it is for. '' when nobody has said. */
  description: string;
  /** The folder it files under. '' when loose at the top. */
  folder: string;
  /** A display-ready cover image URL, or null for the song mosaic. */
  coverUrl: string | null;
  /** Whether the server separates this list's songs ahead of being asked.
   *  Undefined on a local library and on servers that predate the flag. */
  autoStem?: boolean;
  /** Songs filed into this list that the box does not own yet - shown as
   *  arriving ghosts, dissolving into real rows as they land. Only ever
   *  non-empty on a server library; a local list has nowhere to fetch from. */
  wants?: PlaylistWant[];
}

interface PlaylistsContextValue {
  playlists: Playlist[];
  /**
   * Creates a playlist and resolves to its id. Given paths, it is born holding
   * them - which is what "New playlist" in the add-to-playlist panel does, so
   * the song that prompted the new list is in it from the first moment rather
   * than added a beat later.
   */
  create: (name: string, paths?: readonly string[]) => Promise<string>;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  /** Appends a track; already-present paths are left where they are. */
  addTrack: (id: string, path: string) => void;
  removeTrack: (id: string, path: string) => void;
  /**
   * File a song this box does not own yet into a playlist and start fetching
   * it: it shows as an arriving ghost and becomes a real row when it lands.
   * Server-only (a local library has nowhere to fetch from), so absent when
   * signed out - callers gate on its presence to know a not-owned add is
   * possible here. Resolves once the want is filed.
   */
  addWant?: (id: string, target: { artist: string; title: string; url?: string }) => Promise<void>;
  /** Withdraw a not-yet-landed want. Server-only. */
  removeWant?: (id: string, k: string) => void;
  /** The library now owns this want's song; file it into the list at once
   *  rather than wait for the server's sweep. Server-only. */
  settleWant?: (id: string, k: string) => void;
  /** Sets the whole running order - what a drag in the playlist page commits. */
  reorder: (id: string, paths: readonly string[]) => void;
  /**
   * Change a playlist's decoration - description, folder - a field at a time.
   * Where it lands depends on the library: a new server holds it in the
   * playlist's own row, an old one falls back to this device's meta store, and
   * a local library keeps it on the stored object. Callers never know which.
   */
  setMeta: (id: string, patch: { description?: string; folder?: string }) => void;
  /** Ask the server to separate this list ahead of time, or stop. Absent
   *  where the library is local or the server is too old to know. */
  setAutoStem?: (id: string, on: boolean) => void;
  /**
   * Replace (or, with null, remove) a playlist's cover image. Absent when this
   * library has nowhere to keep one - a local library, or a server from before
   * covers existed - so the UI hides the option instead of offering a write
   * that would go nowhere.
   */
  setCover?: (id: string, image: Blob | null) => Promise<void>;
}

const PlaylistsContext = createContext<PlaylistsContextValue | null>(null);

/**
 * Signed into a server, playlists live THERE - made on the phone, present on
 * the desktop, and vice versa, exactly like favourites. Local-only, they live
 * in this device's storage. The two are separate components so a connect or
 * disconnect remounts cleanly rather than blending two sources.
 */
export function PlaylistsProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  return session ? (
    <RemotePlaylists key={session.url} session={session}>
      {children}
    </RemotePlaylists>
  ) : (
    <LocalPlaylists>{children}</LocalPlaylists>
  );
}

function makeId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }
}

function readStored(): Playlist[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return (
      parsed
        .filter(
          (p): p is Playlist =>
            typeof p === 'object' &&
            p !== null &&
            typeof (p as Playlist).id === 'string' &&
            typeof (p as Playlist).name === 'string' &&
            Array.isArray((p as Playlist).paths),
        )
        // Objects written before decoration existed lack the fields; every
        // reader wants strings, so they are filled here rather than checked
        // at fifty call sites.
        .map((p) => ({
          ...p,
          description: typeof p.description === 'string' ? p.description : '',
          folder: typeof p.folder === 'string' ? p.folder : '',
          coverUrl: null,
        }))
    );
  } catch {
    return [];
  }
}

function LocalPlaylists({ children }: { children: ReactNode }) {
  const [playlists, setPlaylists] = useState<Playlist[]>(readStored);

  /*
   * Decoration written before 0.3.286 lived in the device meta store rather
   * than on the playlist objects. Fold it in once and delete it there: two
   * stores that can disagree about one description is how a device shows
   * yesterday's text forever.
   */
  useEffect(() => {
    setPlaylists((prev) =>
      prev.map((p) => {
        const key = metaKey(null, p.id);
        const old = metaFor(key);
        if (!old.description && !old.folder) return p;
        forgetMeta(key);
        return {
          ...p,
          description: p.description || old.description || '',
          folder: p.folder || old.folder || '',
        };
      }),
    );
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(playlists));
    } catch {
      // Storage refusing the write only costs persistence, not the session.
    }
  }, [playlists]);

  const value = useMemo<PlaylistsContextValue>(
    () => ({
      playlists,
      create: (name: string, paths: readonly string[] = []) => {
        const id = makeId();
        const trimmed = name.trim() || 'New Playlist';
        setPlaylists((prev) => [
          ...prev,
          {
            id,
            name: trimmed,
            paths: [...new Set(paths)],
            createdAt: Date.now(),
            description: '',
            folder: '',
            coverUrl: null,
          },
        ]);
        return Promise.resolve(id);
      },
      remove: (id: string) => setPlaylists((prev) => prev.filter((p) => p.id !== id)),
      rename: (id: string, name: string) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        setPlaylists((prev) => prev.map((p) => (p.id === id ? { ...p, name: trimmed } : p)));
      },
      addTrack: (id: string, path: string) =>
        setPlaylists((prev) =>
          prev.map((p) =>
            p.id !== id || p.paths.includes(path) ? p : { ...p, paths: [...p.paths, path] },
          ),
        ),
      removeTrack: (id: string, path: string) =>
        setPlaylists((prev) =>
          prev.map((p) => (p.id === id ? { ...p, paths: p.paths.filter((x) => x !== path) } : p)),
        ),
      reorder: (id: string, paths: readonly string[]) =>
        setPlaylists((prev) => prev.map((p) => (p.id === id ? { ...p, paths: [...paths] } : p))),
      setMeta: (id: string, patch: { description?: string; folder?: string }) =>
        setPlaylists((prev) =>
          prev.map((p) =>
            p.id === id
              ? {
                  ...p,
                  description:
                    patch.description !== undefined ? patch.description.trim() : p.description,
                  folder: patch.folder !== undefined ? patch.folder.trim() : p.folder,
                }
              : p,
          ),
        ),
      // No setCover: a local library has nowhere to keep an image, and
      // offering the option would be a button that cannot work.
    }),
    [playlists],
  );

  return <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>;
}

function RemotePlaylists({ session, children }: { session: ServerSession; children: ReactNode }) {
  // Seeded from the last launch's answer so the tiles paint immediately and
  // the fetch below swaps in place - a strip that assembles tile by tile is
  // the exact jumpiness the feed caches exist to end.
  const [remote, setRemote] = useState<RemotePlaylist[]>(
    () => readFeedCache<RemotePlaylist[]>(session, 'playlists') ?? [],
  );
  // Bumped on every local edit. A fetch snapshots this before asking and only
  // applies its answer if nothing was edited in between - a heartbeat that
  // left before an edit landed must not roll the screen (or the next
  // whole-array PUT) back to the past.
  const editSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seqAtAsk = editSeq.current;
    try {
      const lists = await fetchRemotePlaylists(session);
      if (editSeq.current === seqAtAsk) {
        setRemote(lists);
        writeFeedCache(session, 'playlists', lists);
      }
    } catch {
      // Unreachable right now; whatever is on screen stays, and the next
      // heartbeat tries again.
    }
  }, [session]);

  /*
   * Move decoration written before the server could hold it (0.3.282-285, the
   * device meta store) into the playlist rows, then delete it from the store.
   *
   * Runs off every fetch rather than once behind a flag, because deletion IS
   * the flag: a migrated entry is gone, so the second pass finds nothing and
   * does nothing. That also makes a failed PUT self-healing - the entry
   * survives to be retried on the next heartbeat.
   *
   * The server's copy always wins a disagreement. A non-empty server field
   * means someone has already edited it where everyone can see it, and the
   * device store's version is by definition older - so it is dropped, not
   * merged. Only an EMPTY server field is filled from the store.
   */
  const migrating = useRef(false);
  useEffect(() => {
    if (migrating.current) return;
    const prefix = `${session.url}#`;
    const entries = Object.entries(metaSnapshot()).filter(([k]) => k.startsWith(prefix));
    if (entries.length === 0) return;
    // An old server never sends the fields; nothing can be migrated into it.
    if (!remote.some((p) => p.description !== undefined)) return;
    migrating.current = true;
    void (async () => {
      try {
        for (const [key, old] of entries) {
          const id = Number(key.slice(prefix.length));
          const target = remote.find((p) => p.id === id);
          if (!target || target.description === undefined) {
            // Deleted playlist (or one this fetch missed): nothing to carry.
            if (!target) forgetMeta(key);
            continue;
          }
          const patch: { description?: string; folder?: string } = {};
          if (old.description && !target.description) patch.description = old.description;
          if (old.folder && !target.folder) patch.folder = old.folder;
          if (Object.keys(patch).length > 0) {
            await updateRemotePlaylist(session, id, patch);
          }
          forgetMeta(key);
        }
        await refresh();
      } catch {
        // Unreachable server mid-walk: what migrated is deleted, what did not
        // is still in the store, and the next heartbeat picks it back up.
      } finally {
        migrating.current = false;
      }
    })();
  }, [remote, session, refresh]);

  // Fetched on connect and then on the same half-minute heartbeat the library
  // runs: a playlist made on the phone shows up on the desktop without either
  // device asking.
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  // Every edit is optimistic - the UI answers the press - then stated to the
  // server, and the truth refetched behind it so a refused edit heals.
  const mutate = useCallback(
    (next: RemotePlaylist[], commit: () => Promise<unknown>) => {
      editSeq.current += 1;
      setRemote(next);
      void commit()
        .catch(() => {})
        .finally(() => void refresh());
    },
    [refresh],
  );

  /*
   * The device meta store, subscribed so decoration edits re-render this
   * provider. It matters on exactly one path: a server from before the
   * decoration columns, whose responses carry no `description` field at all.
   * There, reads fall back to what 0.3.282-285 wrote on this device, and
   * writes keep landing there - the feature keeps working, un-shared, until
   * the hub is updated. `undefined` versus `''` is how the two servers are
   * told apart: absent means "never heard of it", empty means "none".
   */
  const metaRev = useSyncExternalStore(subscribeMeta, metaSnapshot, metaSnapshot);

  const value = useMemo<PlaylistsContextValue>(() => {
    const playlists: Playlist[] = remote.map((p) => {
      const fallback = p.description === undefined ? metaFor(metaKey(session.url, String(p.id))) : null;
      return {
        id: String(p.id),
        name: p.name,
        paths: p.tracks.map((id) => remotePath(id)),
        createdAt: p.updatedAt,
        description: p.description ?? fallback?.description ?? '',
        folder: p.folder ?? fallback?.folder ?? '',
        coverUrl: p.cover ? playlistCoverUrl(session, p.id, p.updatedAt) : null,
        autoStem: p.autoStem,
        wants: p.wants ?? [],
      };
    });

    const byId = (id: string) => remote.find((p) => String(p.id) === id);

    return {
      playlists,
      create: async (name: string, paths: readonly string[] = []) => {
        const trimmed = name.trim() || 'New Playlist';
        // Only tracks the server knows can ride a server playlist; a local file
        // becomes one when the folder sync uploads it, not before.
        const tracks = [
          ...new Set(paths.map(trackIdFromPath).filter((t): t is number => t !== null)),
        ];
        const id = await createRemotePlaylist(session, trimmed, tracks);
        editSeq.current += 1;
        setRemote((prev) => [...prev, { id, name: trimmed, updatedAt: Date.now(), tracks }]);
        void refresh();
        return String(id);
      },
      remove: (id: string) => {
        const target = byId(id);
        if (!target) return;
        mutate(
          remote.filter((p) => p.id !== target.id),
          () => deleteRemotePlaylist(session, target.id),
        );
      },
      rename: (id: string, name: string) => {
        const target = byId(id);
        const trimmed = name.trim();
        if (!target || !trimmed) return;
        mutate(
          remote.map((p) => (p.id === target.id ? { ...p, name: trimmed } : p)),
          () => updateRemotePlaylist(session, target.id, { name: trimmed }),
        );
      },
      addTrack: (id: string, path: string) => {
        const target = byId(id);
        const trackId = trackIdFromPath(path);
        // A local file's path cannot ride a server playlist; the folder sync
        // is what turns it into a server track first.
        if (!target || trackId === null || target.tracks.includes(trackId)) return;
        const tracks = [...target.tracks, trackId];
        mutate(
          remote.map((p) => (p.id === target.id ? { ...p, tracks } : p)),
          () => updateRemotePlaylist(session, target.id, { tracks }),
        );
      },
      removeTrack: (id: string, path: string) => {
        const target = byId(id);
        const trackId = trackIdFromPath(path);
        if (!target || trackId === null) return;
        const tracks = target.tracks.filter((t) => t !== trackId);
        mutate(
          remote.map((p) => (p.id === target.id ? { ...p, tracks } : p)),
          () => updateRemotePlaylist(session, target.id, { tracks }),
        );
      },
      addWant: async (id, target) => {
        const pl = byId(id);
        const artist = target.artist.trim();
        const title = target.title.trim();
        if (!pl || !artist || !title) return;
        // An OPTIMISTIC key for the ghost we show until the refetch. It usually
        // matches the server's key_of, but the two fold implementations have
        // drifted at the edges (client titleKey strips "mono"/"stereo", accent
        // folding differs on characters with no canonical decomposition), so
        // this is not guaranteed byte-equal. It does not need to be: the server
        // computes the real key_of for storage and settling, and the refetch
        // right after replaces this ghost with the server's own want. The only
        // cost of a mismatch is that the client fast-path reconcile may miss
        // such a song, and the server sweep files it instead.
        const k = `${fold(artist)}|${titleKey(title)}`;
        // Already filed (a double-tap) - leave the earlier want where it is.
        if ((pl.wants ?? []).some((w) => w.k === k)) return;
        const want: PlaylistWant = { k, title, artist, url: target.url ?? '', createdAt: Date.now() };
        mutate(
          remote.map((p) => (p.id === pl.id ? { ...p, wants: [...(p.wants ?? []), want] } : p)),
          () => addPlaylistWant(session, pl.id, { artist, title, url: target.url }),
        );
      },
      removeWant: (id, k) => {
        const pl = byId(id);
        if (!pl) return;
        mutate(
          remote.map((p) =>
            p.id === pl.id ? { ...p, wants: (p.wants ?? []).filter((w) => w.k !== k) } : p,
          ),
          () => removePlaylistWant(session, pl.id, k),
        );
      },
      settleWant: (id, k) => {
        const pl = byId(id);
        if (!pl) return;
        // Drop the ghost locally and ask the box to file the real row; the
        // refetch behind it brings the track into the list either way.
        mutate(
          remote.map((p) =>
            p.id === pl.id ? { ...p, wants: (p.wants ?? []).filter((w) => w.k !== k) } : p,
          ),
          () => settlePlaylistWant(session, pl.id, k),
        );
      },
      reorder: (id: string, paths: readonly string[]) => {
        const target = byId(id);
        if (!target) return;
        // The new order as ids. Anything that does not resolve is dropped from
        // the write rather than guessed at, and the refetch behind the PUT is
        // what settles the truth either way.
        const tracks = paths.map(trackIdFromPath).filter((t): t is number => t !== null);
        mutate(
          remote.map((p) => (p.id === target.id ? { ...p, tracks } : p)),
          () => updateRemotePlaylist(session, target.id, { tracks }),
        );
      },
      setAutoStem: (id: string, on: boolean) => {
        const target = byId(id);
        // Undefined means a server that has never heard of the flag: there is
        // nothing to write to, and pretending otherwise would show a switch
        // that forgets itself on the next fetch.
        if (!target || target.autoStem === undefined) return;
        mutate(
          remote.map((p) => (p.id === target.id ? { ...p, autoStem: on } : p)),
          () => updateRemotePlaylist(session, target.id, { autoStem: on }),
        );
      },
      setMeta: (id: string, patch: { description?: string; folder?: string }) => {
        const target = byId(id);
        if (!target) return;
        const clean = {
          ...(patch.description !== undefined ? { description: patch.description.trim() } : {}),
          ...(patch.folder !== undefined ? { folder: patch.folder.trim() } : {}),
        };
        if (target.description === undefined) {
          // Old server: keep writing where 0.3.282 wrote, so the edit is not
          // lost into a PUT the server would silently ignore.
          setStoredMeta(metaKey(session.url, id), clean);
          return;
        }
        mutate(
          remote.map((p) => (p.id === target.id ? { ...p, ...clean } : p)),
          () => updateRemotePlaylist(session, target.id, clean),
        );
      },
      setCover: async (id: string, image: Blob | null) => {
        const target = byId(id);
        if (!target) return;
        // Not optimistic, unlike everything else here: there is nothing honest
        // to show until the server has the bytes, and the refetch behind it is
        // what carries the new updatedAt that busts the image URL.
        if (image) await uploadPlaylistCover(session, target.id, image);
        else await removePlaylistCover(session, target.id);
        editSeq.current += 1;
        await refresh();
      },
    };
  }, [remote, session, mutate, refresh, metaRev]);

  return <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>;
}

export function usePlaylists(): PlaylistsContextValue {
  const value = useContext(PlaylistsContext);
  if (!value) throw new Error('usePlaylists must be used within a PlaylistsProvider');
  return value;
}
