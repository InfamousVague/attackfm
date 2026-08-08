import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLibrary } from '../../app/library.tsx';
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
  type MusicImportJob,
} from './musicImport.ts';
import { DownloadsContext, type DownloadsContextValue } from './downloadsContext.ts';
import { settlePendingSyncs } from './spotifyAccount.ts';

/**
 * Owns the music-import queue: seeds from the backend, subscribes to live queue
 * broadcasts, and rescans the library whenever an import finishes so downloaded
 * songs appear without a manual refresh. Mounted by the plugin runtime inside
 * the LibraryProvider (the Plugin.Provider contract guarantees it), so
 * switching the plugin off tears the subscription down with the component.
 *
 * This file exports only the provider component so React Fast Refresh can update
 * it in place; the context and `useDownloads` hook live in downloadsContext.ts.
 */
export function DownloadsProvider({ children }: { children: ReactNode }) {
  const { source, musicDir, rescan } = useLibrary();
  // Downloads always land in a LOCAL folder. musicDir is one only while the
  // library source is local - connected to a server it is that server's URL,
  // and passing it through once minted a literal "https:/host/" directory tree
  // beside the binary. undefined hands the choice to the backend's fallback
  // (the OS music folder), which is also where the uploader looks.
  const downloadDir = source === 'local' ? musicDir : undefined;
  const [jobs, setJobs] = useState<MusicImportJob[]>([]);
  const [paused, setPausedState] = useState(false);
  // Latest values kept in refs so the subscription effect can stay mount-once.
  const rescanRef = useRef(rescan);
  rescanRef.current = rescan;
  const doneIds = useRef<Set<string>>(new Set());

  const applyJobs = useCallback((next: MusicImportJob[]) => {
    setJobs(next);
    const done = next.filter((j) => j.state === 'done').map((j) => j.id);
    const isFresh = done.some((id) => !doneIds.current.has(id));
    doneIds.current = new Set(done);
    if (isFresh) void rescanRef.current();
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
