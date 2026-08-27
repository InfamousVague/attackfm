import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useLibrary } from '@attackfm/app/library';
import { noteImportServerRejected, useImportServer } from '@attackfm/app/importServer';
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
 * Owns the music-import queue. One transport: a SERVER. Enqueue posts a link,
 * the server downloads and indexes it where it filed the file, and a poll
 * watches the jobs - the same path on every platform, which is the point: the
 * app itself carries no download machinery, this plugin is a remote control
 * for a server's engine, and a desktop is no more special than a phone.
 * (The local SpotiFLAC engine that desktop builds once compiled in is gone
 * with it; requiresServer on the plugin says so.)
 *
 * WHICH server is not this file's decision any more. It used to be
 * `useServerSession()` - the box you are signed into - which was wrong the
 * moment the downloader lived somewhere other than the library: one server has
 * SpotiFLAC, another has the disk. `useImportServer()` answers that question in
 * core, and its peer-sync copies finished songs to the library afterwards.
 *
 * Mounted by the plugin runtime inside the LibraryProvider, so switching the
 * plugin off tears everything down with the component.
 */
export function DownloadsProvider({ children }: { children: ReactNode }) {
  const target = useImportServer();
  // Keyed on the TARGET, not the session. Keyed on the session while polling a
  // peer, changing the import server would leave the previous box's `jobs`,
  // `doneIds` and the `seeded` latch alive: the new server's job ids all read
  // as newly finished, firing a phantom rescan and a settlePendingSyncs
  // against a queue that never ran there.
  return <ServerDownloads key={target?.url ?? 'none'}>{children}</ServerDownloads>;
}

/**
 * The server-backed queue. A short poll rather than a socket: imports are a
 * rare, human-paced action, and the same half-minute rhythm the library already
 * runs on is plenty. Finishing an import bumps the catalog rev server-side, so
 * the library's own delta sync surfaces the new songs - this provider only has
 * to notice "done" and nudge a rescan so it happens now rather than at the
 * next heartbeat.
 */
function ServerDownloads({ children }: { children: ReactNode }) {
  const target = useImportServer();
  const { rescan } = useLibrary();
  const [jobs, setJobs] = useState<MusicImportJob[]>([]);
  const rescanRef = useRef(rescan);
  rescanRef.current = rescan;
  const targetRef = useRef(target);
  targetRef.current = target;
  const doneIds = useRef<Set<string>>(new Set());
  const seeded = useRef(false);

  const apply = useCallback((next: MusicImportJob[]) => {
    setJobs(next);
    const done = next.filter((j) => j.state === 'done').map((j) => j.id);
    const isFresh = seeded.current && done.some((id) => !doneIds.current.has(id));
    seeded.current = true;
    doneIds.current = new Set(done);
    if (isFresh) {
      // The app's own watcher (notify/DownloadNotices) owns what a landing
      // LOOKS like now - the bell, the buzz, the row that is still there
      // tomorrow. A toast was the wrong shape for it: this fires from a
      // background poll minutes after you asked, so it covered whatever you
      // had moved on to in order to announce something that is now simply a
      // row in your library.
      //
      // What is left here is the provider's actual business: finishing an
      // import bumps the catalog, and nudging a rescan means the new songs are
      // there when you go looking rather than at the next heartbeat.
      void rescanRef.current();
    }
    // The import target, not the session: this job list came from there, so
    // the "synced" mark belongs on the same box. Marked against the session
    // instead, a peer-run import would mark jobs that server never saw and
    // leave the peer's own pending entries unsettled forever.
    if (targetRef.current) void settlePendingSyncs(targetRef.current, next);
  }, []);

  // Whether anything is actually in flight decides the pace below.
  const active = jobs.some((j) => j.state === 'queued' || j.state === 'downloading');

  useEffect(() => {
    if (!target) return;
    let alive = true;
    const poll = async () => {
      try {
        const list = await serverListImports(target);
        if (alive) apply(list);
      } catch (err) {
        // Unreachable right now; the next tick tries again. A rejection is a
        // different animal and gets said out loud: the chosen box is reachable
        // and refusing this device, which no amount of retrying fixes, and
        // which the picker turns into a decision rather than a silent stall.
        noteRejection(target.url, err);
      }
    };
    void poll();
    // Faster while something is in flight, idle otherwise - imports take
    // minutes, and a settled queue does not need watching every few seconds.
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
  }, [target, apply, active]);

  const value = useMemo<DownloadsContextValue>(() => {
    const ordered = [...jobs].sort((a, b) => {
      const aActive = a.state === 'queued' || a.state === 'downloading';
      const bActive = b.state === 'queued' || b.state === 'downloading';
      if (aActive !== bActive) return aActive ? -1 : 1;
      return b.createdAt - a.createdAt;
    });
    const refetch = () => {
      if (target) void serverListImports(target).then(apply).catch(() => {});
    };
    return {
      jobs: ordered,
      active: ordered.filter((j) => j.state === 'queued' || j.state === 'downloading'),
      // The server queue has no global pause; it simply runs what it is given.
      paused: false,
      enqueue: async (url: string, nowPlaying = false) => {
        if (!target) throw new Error('Not connected to a server.');
        try {
          const job = await serverEnqueueImport(target, url, nowPlaying);
          // Shown at once for feedback, deduped by id so a poll that already
          // raced this job in cannot leave two cards sharing a React key.
          setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
          return job;
        } catch (err) {
          noteRejection(target.url, err);
          throw err;
        }
      },
      remove: (id: string) => {
        if (target) void serverRemoveImport(target, id).then(refetch).catch(() => {});
      },
      retry: (id: string) => {
        if (target) void serverRetryImport(target, id).then(refetch).catch(() => {});
      },
      cancel: (id: string) => {
        if (target) void serverCancelImport(target, id).then(refetch).catch(() => {});
      },
      setPaused: () => {},
      clearFinished: () => {
        if (target) void serverClearImports(target, ['done', 'error']).then(refetch).catch(() => {});
      },
    };
  }, [jobs, target, apply]);

  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

/**
 * Tell core when the chosen import server refuses this device.
 *
 * Read off the message rather than a status field because `serverRequest`
 * throws a plain Error: `require_caller` answers a bare 401 with no body, so
 * the message it builds is exactly "401 Unauthorized". Anything else is a
 * server that is merely unreachable or busy, and saying "it rejected you"
 * about a flaky Wi-Fi would send people revoking working tokens. Getting this
 * check wrong costs only the banner, never an import.
 */
function noteRejection(url: string, err: unknown): void {
  const message = err instanceof Error ? err.message : '';
  if (!/^401\b/.test(message) && !/unauthori[sz]ed/i.test(message)) return;
  noteImportServerRejected(url, 'it did not accept this device’s sign-in.');
}
