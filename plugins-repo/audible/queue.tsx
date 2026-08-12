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
import { audibleImport, audibleJobs, type AudibleBook, type AudibleJob } from './audibleAccount.ts';

/**
 * The Audible download queue, held by the plugin rather than by the page that
 * shows it.
 *
 * A book here is a long errand - download, decrypt, file - and the one thing
 * you must be able to do meanwhile is walk away. Polling from the downloader
 * page meant the queue only advanced while that page was open, so watching a
 * book on the Downloads page showed a card that never moved. The poll lives
 * here instead, mounted for as long as the plugin is on.
 */

interface AudibleQueue {
  jobs: AudibleJob[];
  /** The live job for one of your Audible books, if it is in the queue. */
  jobFor: (asin: string) => AudibleJob | undefined;
  /** Anything still working - what the page watches to know when to refresh. */
  busy: boolean;
  pull: (book: AudibleBook) => Promise<AudibleJob>;
  hide: (id: string) => void;
  /** Hide the finished and failed cards. The hub keeps its queue in memory and
   *  has nothing to delete, so this is a local dismissal. */
  clearFinished: () => void;
}

const QueueContext = createContext<AudibleQueue | null>(null);

/** Everything that is not an ending is work in progress - the three middle
 *  states differ in what they SAY, not in whether the queue is moving. */
function isActive(job: AudibleJob): boolean {
  return job.state !== 'done' && job.state !== 'error';
}

export function AudibleQueueProvider({ children }: { children: ReactNode }) {
  const { session } = useServerSession();
  const { rescan } = useLibrary();
  const [jobs, setJobs] = useState<AudibleJob[]>([]);
  const [hidden, setHidden] = useState<readonly string[]>([]);

  const busy = jobs.some(isActive);
  useEffect(() => {
    if (!session) {
      setJobs([]);
      return;
    }
    let live = true;
    const poll = () => {
      // A hub with no Audible account answers this the same way an old hub
      // does - unhelpfully - and either way the right queue to show is none.
      void audibleJobs(session)
        .then((js) => {
          if (!live) return;
          setJobs((prev) => {
            // The last book has landed: walk the library so the shelf has it.
            if (prev.some(isActive) && !js.some(isActive)) void rescan();
            return js;
          });
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, busy ? 3_000 : 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, busy, rescan]);

  const visible = useMemo(() => jobs.filter((j) => !hidden.includes(j.id)), [jobs, hidden]);

  const pull = useCallback(
    async (book: AudibleBook) => {
      if (!session) throw new Error('Connect a server first.');
      const job = await audibleImport(session, book);
      // Show it now rather than on the next poll - a tap should land visibly
      // inside the same frame.
      setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]);
      setHidden((prev) => prev.filter((id) => id !== job.id));
      return job;
    },
    [session],
  );

  const value = useMemo<AudibleQueue>(
    () => ({
      jobs: visible,
      jobFor: (asin) => visible.find((j) => j.asin === asin),
      busy,
      pull,
      hide: (id) => setHidden((prev) => (prev.includes(id) ? prev : [...prev, id])),
      clearFinished: () => setHidden(jobs.filter((j) => !isActive(j)).map((j) => j.id)),
    }),
    [visible, jobs, busy, pull],
  );

  return <QueueContext.Provider value={value}>{children}</QueueContext.Provider>;
}

/** The queue, for the plugin's own surfaces. Inert when the provider is
 *  missing, which happens only if the plugin is off. */
export function useAudibleQueue(): AudibleQueue {
  return (
    useContext(QueueContext) ?? {
      jobs: [],
      jobFor: () => undefined,
      busy: false,
      pull: () => Promise.reject(new Error('The Audible plugin is switched off.')),
      hide: () => {},
      clearFinished: () => {},
    }
  );
}
