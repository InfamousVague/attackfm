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
  createRemotePlaylist,
  deleteRemotePlaylist,
  fetchRemotePlaylists,
  remotePath,
  trackIdFromPath,
  updateRemotePlaylist,
  type RemotePlaylist,
  type ServerSession,
} from './server.ts';
import { useServerSession } from './serverSession.tsx';

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
}

interface PlaylistsContextValue {
  playlists: Playlist[];
  /** Creates an empty playlist and resolves to its id. */
  create: (name: string) => Promise<string>;
  remove: (id: string) => void;
  rename: (id: string, name: string) => void;
  /** Appends a track; already-present paths are left where they are. */
  addTrack: (id: string, path: string) => void;
  removeTrack: (id: string, path: string) => void;
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
    return parsed.filter(
      (p): p is Playlist =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as Playlist).id === 'string' &&
        typeof (p as Playlist).name === 'string' &&
        Array.isArray((p as Playlist).paths),
    );
  } catch {
    return [];
  }
}

function LocalPlaylists({ children }: { children: ReactNode }) {
  const [playlists, setPlaylists] = useState<Playlist[]>(readStored);

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
      create: (name: string) => {
        const id = makeId();
        const trimmed = name.trim() || 'New Playlist';
        setPlaylists((prev) => [...prev, { id, name: trimmed, paths: [], createdAt: Date.now() }]);
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
    }),
    [playlists],
  );

  return <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>;
}

function RemotePlaylists({ session, children }: { session: ServerSession; children: ReactNode }) {
  const [remote, setRemote] = useState<RemotePlaylist[]>([]);
  // Bumped on every local edit. A fetch snapshots this before asking and only
  // applies its answer if nothing was edited in between - a heartbeat that
  // left before an edit landed must not roll the screen (or the next
  // whole-array PUT) back to the past.
  const editSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seqAtAsk = editSeq.current;
    try {
      const lists = await fetchRemotePlaylists(session);
      if (editSeq.current === seqAtAsk) setRemote(lists);
    } catch {
      // Unreachable right now; whatever is on screen stays, and the next
      // heartbeat tries again.
    }
  }, [session]);

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

  const value = useMemo<PlaylistsContextValue>(() => {
    const playlists: Playlist[] = remote.map((p) => ({
      id: String(p.id),
      name: p.name,
      paths: p.tracks.map(remotePath),
      createdAt: p.updatedAt,
    }));

    const byId = (id: string) => remote.find((p) => String(p.id) === id);

    return {
      playlists,
      create: async (name: string) => {
        const trimmed = name.trim() || 'New Playlist';
        const id = await createRemotePlaylist(session, trimmed);
        editSeq.current += 1;
        setRemote((prev) => [...prev, { id, name: trimmed, updatedAt: Date.now(), tracks: [] }]);
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
    };
  }, [remote, session, mutate, refresh]);

  return <PlaylistsContext.Provider value={value}>{children}</PlaylistsContext.Provider>;
}

export function usePlaylists(): PlaylistsContextValue {
  const value = useContext(PlaylistsContext);
  if (!value) throw new Error('usePlaylists must be used within a PlaylistsProvider');
  return value;
}
