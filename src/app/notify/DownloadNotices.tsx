import { useEffect, useRef } from 'react';
import { useHaptics, useToast } from '@glacier/react';
import { artSized } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useDownloadsOptional, type MusicImportState } from '../../plugins/importsBridge.ts';
import { noteNotice, setNoticeScope } from './notices.ts';
import { planFromQueue, snapshotOf } from './downloadPlan.ts';

/**
 * What a download does to the app, decided in one place.
 *
 * The two halves of the news are not the same kind of event, and used to be
 * treated as if they were:
 *
 *   - STARTING is an answer. You pressed something, and the app is confirming
 *     it heard you. That is worth two seconds at the top of the screen and
 *     then gone, because by the time it fades you already know.
 *   - LANDING is news you may be anywhere for. It arrives from a background
 *     poll, minutes later, while you are reading an artist page. Covering
 *     whatever you are doing to announce a thing that is now simply a row in
 *     your library is an interruption that buys nothing - so it goes behind
 *     the bell, where it waits, and where it is still there tomorrow.
 *
 * Both halves used to live in the importer plugin. They live here because the
 * plugin's job is the QUEUE, not the app's surfaces, and because saying a
 * sentence differently should not cost a plugin rebuild, a version bump and a
 * republish.
 *
 * The DECISION lives in downloadPlan.ts, as arithmetic over two snapshots with
 * the clock passed in. This component is only the part that cannot be pure:
 * holding the previous snapshot, and performing what the plan says.
 *
 * Headless: it renders nothing. It is mounted where the floating chip used to
 * be, inside the plugin providers (so there is a queue to read) and inside the
 * toast provider (so there is somewhere to say it).
 */

/** How long a start line stays. Long enough to read four words, short enough
 *  that queueing an album's worth does not build a wall. */
const START_TOAST_MS = 2200;

export function DownloadNotices() {
  const { session } = useServerSession();
  const dl = useDownloadsOptional();
  const { toast } = useToast();
  const haptic = useHaptics();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const hapticRef = useRef(haptic);
  hapticRef.current = haptic;

  /** The queue as of the last look, or null when nothing has been seen yet.
   *  Null is NOT an empty queue - see planFromQueue. */
  const seen = useRef<Map<string, MusicImportState> | null>(null);

  // FIRST effect, deliberately. Effects run in declaration order, and the diff
  // below must never compare one server's queue against another's - switching
  // accounts would otherwise report the whole of the new server's history as
  // having just arrived.
  const scope = session ? `${session.url}:${session.username}` : null;
  useEffect(() => {
    setNoticeScope(scope);
    seen.current = null;
  }, [scope]);

  const jobs = dl?.jobs;
  useEffect(() => {
    if (!jobs) return;

    // An EMPTY queue teaches nothing: the provider starts at `[]` and fills it
    // from an async poll, so a baseline taken there is spent on a snapshot
    // that says nothing about the server - and with no jobs there is nothing
    // to report either way, so waiting costs nothing.
    if (seen.current === null && jobs.length === 0) return;

    // Both paths go through the planner, including the very first one: a seed
    // is silent about landings but still answers for work that just started.
    // See planFromQueue - getting that wrong is what silenced the first
    // download of every session that began with an empty queue.
    const plan = planFromQueue(seen.current, jobs, Date.now());
    seen.current = snapshotOf(jobs);

    for (const n of plan.notices) {
      noteNotice({
        id: n.id,
        kind: n.kind,
        title: n.title,
        body: n.body,
        art: artSized(n.artUrl, 160),
        door: n.door,
      });
    }

    if (plan.started.length === 1) {
      const one = plan.started[0]!;
      toastRef.current({
        message: one.title ? `Downloading “${one.title}”` : 'Downloading that link…',
        duration: START_TOAST_MS,
      });
    } else if (plan.started.length > 1) {
      toastRef.current({
        message: `${plan.started.length} downloads started`,
        duration: START_TOAST_MS,
      });
    }

    // One buzz per tick that landed anything, not one per song: an album
    // finishing is one arrival to a person, however many rows it wrote.
    if (plan.landed > 0) hapticRef.current('success');
  }, [jobs]);

  return null;
}
