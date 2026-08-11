import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLibrary } from '@attackfm/app/library';
import { useServerSession } from '@attackfm/app/serverSession';
import {
  serverCancelImport,
  serverClearImports,
  serverEnqueueImport,
  serverListImports,
  serverRemoveImport,
  serverRetryImport,
  type MusicImportJob,
} from './musicImport.ts';
import { DownloadsContext, type DownloadsContextValue } from '@attackfm/app/importsBridge';
import { settlePendingSyncs } from './spotifyAccount.ts';

/**
 * Owns the music-import queue. One transport: the HUB. Enqueue posts a link,
 * the server downloads and indexes it where the music lives, and a poll
 * watches the jobs - the same path on every platform, which is the point: the
 * app itself carries no download machinery, this plugin is a remote control
 * for the server's engine, and a desktop is no more special than a phone.
 * (The local SpotiFLAC engine that desktop builds once compiled in is gone
 * with it; requiresServer on the plugin says so.)
 *
 * Mounted by the plugin runtime inside the LibraryProvider, so switching the
 * plugin off tears everything down with the component.
 */
export function DownloadsProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
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
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const doneIds = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  const apply = useCallback((next: MusicImportJob[]) => {
    setJobs(next);
    const done = next.filter((j) => j.state === 'done').map((j) => j.id);
    const isFresh = seeded.current && done.some((id) => !doneIds.current.has(id));
    seeded.current = true;
    doneIds.current = new Set(done);
    if (isFresh) void rescanRef.current();
    if (sessionRef.current) void settlePendingSyncs(sessionRef.current, next);
  }, []);

  // Whether anything is actually in flight decides the pace below.
  const active = jobs.some((j) => j.state === 'queued' || j.state === 'downloading');

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
    // (The comment used to claim this; now the interval actually does it.)
    // Hidden, it does not poll at all. A fresh job never waits out the idle
    // minute: enqueue seeds it into state at once, which flips `active` and
    // re-arms this at the fast pace.
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void poll();
    }, active ? 5000 : 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [session, apply, active]);

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
