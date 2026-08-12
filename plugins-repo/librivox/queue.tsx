import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLibrary } from '@attackfm/app/library';
import { useServerSession } from '@attackfm/app/serverSession';
import { bookJobs, importBook, type BookJob } from './api.ts';

/**
 * The book queue, held by the plugin rather than by either surface that shows
 * it.
 *
 * Two things watch this queue and they are never mounted together: the
 * catalogue page marks the row of a book being pulled, and the Downloads page
 * shows the queue whole beside the music importer's. Polling from whichever
 * page happened to be open meant the queue only advanced while someone was
 * looking at it - a book pulled from the catalogue then went quiet the moment
 * you walked to Downloads to watch it. So the poll lives here, in the
 * provider, which is mounted for as long as the plugin is switched on.
 */

interface BookQueue {
  jobs: BookJob[];
  /** The live job for a catalogue book, if it is in the queue. */
  jobFor: (bookId: number) => BookJob | undefined;
  /** Queue a book; resolves with the job the server minted. */
  pull: (bookId: number) => Promise<BookJob>;
  /** Hide one finished card. */
  hide: (id: string) => void;
  /** Hide the finished and failed cards. The server keeps its queue in memory
   *  and has nothing to delete, so this is a local dismissal - the cards go,
   *  and a restart of the hub is what actually forgets them. */
  clearFinished: () => void;
}

const QueueContext = createContext<BookQueue | null>(null);

function isActive(job: BookJob): boolean {
  return job.state === 'queued' || job.state === 'downloading';
}

export function BookQueueProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const { rescan } = useLibrary();
  const [jobs, setJobs] = useState<BookJob[]>([]);
  const [hidden, setHidden] = useState<readonly string[]>([]);

  const active = jobs.some(isActive);
  useEffect(() => {
    if (!session) {
      setJobs([]);
      return;
    }
    let live = true;
    const poll = () => {
      void bookJobs(session)
        .then((js) => {
          if (!live) return;
          setJobs((prev) => {
            // The moment the last book lands, walk the library so the shelf
            // has it - the sections are on disk but nothing has indexed them
            // into this client yet.
            const was = prev.some(isActive);
            const is = js.some(isActive);
            if (was && !is) void rescan();
            return js;
          });
        })
        .catch(() => {});
    };
    poll();
    // Three seconds while something is moving, half a minute when nothing is:
    // a queue nobody is filling should not keep a phone's radio awake.
    const timer = window.setInterval(poll, active ? 3_000 : 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, active, rescan]);

  const visible = useMemo(() => jobs.filter((j) => !hidden.includes(j.id)), [jobs, hidden]);

  const pull = useCallback(
    async (bookId: number) => {
      if (!session) throw new Error('Connect a server first.');
      const job = await importBook(session, bookId);
      // Show it immediately rather than on the next poll - a tap should have a
      // consequence inside the same frame.
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      setHidden((prev) => prev.filter((id) => id !== job.id));
      return job;
    },
    [session],
  );

  const value = useMemo<BookQueue>(
    () => ({
      jobs: visible,
      jobFor: (bookId) => visible.find((j) => j.bookId === bookId),
      pull,
      hide: (id) => setHidden((prev) => (prev.includes(id) ? prev : [...prev, id])),
      clearFinished: () =>
        setHidden(jobs.filter((j) => !isActive(j)).map((j) => j.id)),
    }),
    [visible, jobs, pull],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

/** The queue, for the plugin's own surfaces. Empty and inert when the provider
 *  is missing, which happens only if the plugin is off. */
export function useBookQueue(): BookQueue {
  return (
    useContext(QueueContext) ?? {
      jobs: [],
      jobFor: () => undefined,
      pull: () => Promise.reject(new Error('LibriVox is switched off.')),
      hide: () => {},
      clearFinished: () => {},
    }
  );
}
