import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLibrary } from '../../app/library.tsx';
import { useLibrarySync } from '../../app/librarySync.tsx';
import { useServerSession } from '../../app/serverSession.tsx';
import { canRunSubprocesses } from '../../app/platform.ts';
import { isTauri, safeUnlisten } from '../../app/tauri.ts';
import {
  cancelMusicImport,
  clearMusicImports,
  enqueueMusicImport,
  getDownloadsPaused,
  listMusicImports,
  removeMusicImport,
  retryMusicImport,
  setDownloadsPaused,
  serverCancelImport,
  serverClearImports,
  serverEnqueueImport,
  serverListImports,
  serverRemoveImport,
  serverRetryImport,
  type MusicImportJob,
} from './musicImport.ts';
import { DownloadsContext, type DownloadsContextValue } from './downloadsContext.ts';
import { settlePendingSyncs } from './spotifyAccount.ts';

/**
 * Owns the music-import queue. Two transports behind one context, chosen by
 * where the engine can actually run - NOT merely by whether a server is
 * connected:
 *
 * - A desktop (canRunSubprocesses) always uses its LOCAL engine, server or
 *   not. This is what keeps imports working on a desktop with no server at
 *   all, and keeps a connected desktop from depending on the box having
 *   SpotiFLAC installed - the results ride up to a connected server through
 *   the ordinary folder sync.
 * - Anywhere else (a phone, a browser) the engine is the HUB: enqueue posts a
 *   link, the server downloads and indexes it, and a poll watches the jobs.
 *   This is the only path a phone has, and it needs a connected server.
 *
 * The wire shape is identical, so nothing downstream knows which is in play.
 * Mounted by the plugin runtime inside the LibraryProvider, so switching the
 * plugin off tears everything down with the component.
 */
export function DownloadsProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  // The local engine wins wherever it exists; the server engine is the
  // fallback for devices that have none of their own.
  if (canRunSubprocesses) return <LocalDownloads>{children}</LocalDownloads>;
  return <ServerDownloads key={session?.url ?? 'none'}>{children}</ServerDownloads>;
}

/**
 * The hub-backed queue. A short poll rather than a socket: imports are a rare,
 * human-paced action, and the same half-minute rhythm the library already
 * runs on is plenty. Finishing an import bumps the catalog rev server-side, so
 * the library's own delta sync surfaces the new songs - this provider only has
 * to notice "done" and nudge a rescan so it happens now rather than at the
 * next heartbeat.
 */
function ServerDownloads({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const { rescan } = useLibrary();
  const [jobs, setJobs] = useState<MusicImportJob[]>([]);
  const rescanRef = useRef(rescan);
  rescanRef.current = rescan;
  const doneIds = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  const apply = useCallback((next: MusicImportJob[]) => {
    setJobs(next);
    const done = next.filter((j) => j.state === 'done').map((j) => j.id);
    const isFresh = seeded.current && done.some((id) => !doneIds.current.has(id));
    seeded.current = true;
    doneIds.current = new Set(done);
    if (isFresh) void rescanRef.current();
    void settlePendingSyncs(next);
  }, []);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const poll = async () => {
      try {
        const list = await serverListImports(session);
        if (alive) apply(list);
      } catch {
        // Unreachable right now; the next tick tries again.
      }
    };
    void poll();
    // Faster while something is in flight, idle otherwise - imports take
    // minutes, and a settled queue does not need watching every few seconds.
    const interval = window.setInterval(poll, 5000);
    return () => {
      alive = false;
      window.clearInterval(interval);
    };
  }, [session, apply]);

  const value = useMemo<DownloadsContextValue>(() => {
    const ordered = [...jobs].sort((a, b) => {
      const aActive = a.state === 'queued' || a.state === 'downloading';
      const bActive = b.state === 'queued' || b.state === 'downloading';
      if (aActive !== bActive) return aActive ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
    const refetch = () => {
      if (session) void serverListImports(session).then(apply).catch(() => {});
    };
    return {
      jobs: ordered,
      active: ordered.filter((j) => j.state === 'queued' || j.state === 'downloading'),
      // The hub queue has no global pause; it simply runs what it is given.
      paused: false,
      enqueue: async (url: string) => {
        if (!session) throw new Error('Not connected to a server.');
        const job = await serverEnqueueImport(session, url);
        // Shown at once for feedback, deduped by id so a poll that already
        // raced this job in cannot leave two cards sharing a React key.
        setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
        return job;
      },
      remove: (id: string) => {
        if (session) void serverRemoveImport(session, id).then(refetch).catch(() => {});
      },
      retry: (id: string) => {
        if (session) void serverRetryImport(session, id).then(refetch).catch(() => {});
      },
      cancel: (id: string) => {
        if (session) void serverCancelImport(session, id).then(refetch).catch(() => {});
      },
      setPaused: () => {},
      clearFinished: () => {
        if (session) void serverClearImports(session, ['done', 'error']).then(refetch).catch(() => {});
      },
    };
  }, [jobs, session, apply]);

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

function LocalDownloads({ children }: { children: ReactNode }) {
  const { source, musicDir, rescan } = useLibrary();
  const { syncNow } = useLibrarySync();
  // Downloads always land in a LOCAL folder. musicDir is one only while the
  // library source is local - connected to a server it is that server's URL,
  // and passing it through once minted a literal "https:/host/" directory tree
  // beside the binary. Connected, the CHOSEN local folder still applies when
  // there is one - it is the folder the sync engine walks, and downloads that
  // land anywhere else would never ride up to the server.
  const downloadDir =
    source === 'local' ? musicDir : (localStorage.getItem('attackfm-music-dir') ?? undefined);
  const [jobs, setJobs] = useState<MusicImportJob[]>([]);
  const [paused, setPausedState] = useState(false);
  // Latest values kept in refs so the subscription effect can stay mount-once.
  const rescanRef = useRef(rescan);
  rescanRef.current = rescan;
  const syncNowRef = useRef(syncNow);
  syncNowRef.current = syncNow;
  const doneIds = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  const applyJobs = useCallback((next: MusicImportJob[]) => {
    setJobs(next);
    const done = next.filter((j) => j.state === 'done').map((j) => j.id);
    const isFresh = seeded.current && done.some((id) => !doneIds.current.has(id));
    // The first delivery is history, not news: jobs finished in past runs
    // must not fire a rescan or a sync on every launch.
    seeded.current = true;
    doneIds.current = new Set(done);
    const anyWriting = next.some((j) => j.state === 'queued' || j.state === 'downloading');
    if (isFresh) {
      // A local library re-walks its folder and sees the new files directly.
      void rescanRef.current();
      // Signed into a server, the files landed in a folder the catalog never
      // reads - the folder sync carries them up, and the catalog follows. But
      // only once the queue has DRAINED: up to three jobs write into this
      // folder at once, and a sync pass that walks it mid-write can upload a
      // truncated file whose tags then block the finished one. The last job
      // to finish is the one that triggers.
      if (!anyWriting) syncNowRef.current();
    }
    // Spotify sync marks ride download completion, not enqueue - a failed
    // download must stay offered. Cheap when nothing is pending.
    void settlePendingSyncs(next);
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const [initial, isPaused] = await Promise.all([listMusicImports(), getDownloadsPaused()]);
        if (alive) {
          applyJobs(initial);
          setPausedState(isPaused);
        }
        // A cleanup that already ran (a StrictMode ghost mount, a hot-reload
        // remount) means nobody wants this subscription: bail before listen()
        // rather than registering a listener only to tear it straight down -
        // an unlisten issued that fast can outrun its own registration in the
        // webview and leave a zombie listener behind.
        if (!alive) return;
        const mod = await import('@tauri-apps/api/event');
        const un = await mod.listen<MusicImportJob[]>('music-imports://state', (e) => applyJobs(e.payload));
        if (alive) unlisten = un;
        else safeUnlisten(un);
      } catch {
        // No backend (browser) - the queue simply stays empty.
      }
    })();
    return () => {
      alive = false;
      if (unlisten) safeUnlisten(unlisten);
    };
  }, [applyJobs]);

  const value = useMemo<DownloadsContextValue>(() => {
    // Newest first, with anything still working pinned above finished cards.
    const ordered = [...jobs].sort((a, b) => {
      const aActive = a.state === 'queued' || a.state === 'downloading';
      const bActive = b.state === 'queued' || b.state === 'downloading';
      if (aActive !== bActive) return aActive ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
    return {
      jobs: ordered,
      active: ordered.filter((j) => j.state === 'queued' || j.state === 'downloading'),
      paused,
      enqueue: (url: string) => enqueueMusicImport(url, downloadDir),
      remove: (id: string) => void removeMusicImport(id),
      retry: (id: string) => void retryMusicImport(id),
      cancel: (id: string) => void cancelMusicImport(id),
      setPaused: (next: boolean) => {
        setPausedState(next);
        void setDownloadsPaused(next);
      },
      clearFinished: () => void clearMusicImports(['done', 'error']),
    };
  }, [jobs, downloadDir, paused]);

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}
