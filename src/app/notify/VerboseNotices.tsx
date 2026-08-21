import { useEffect, useRef } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { verboseNoticesEnabled } from '../settings/behaviourPrefs.ts';
import { fetchActivity } from '../api/activity.ts';
import type { ActivityEvent } from '../api/activity.ts';
import { noteNotice } from './notices.ts';

/**
 * The verbose watcher: turns the server's activity feed into bell rows while
 * the device's "verbose notifications" switch is on.
 *
 * Headless, mounted beside DownloadNotices at the same depth in App (inside
 * the plugin providers and under ToastProvider).
 *
 * WHY IT SEEDS. The first poll of a fresh install asks with `since=0`, which
 * the server answers with the most recent page - a week of history. Announcing
 * that would ring the bell forty times for work finished last Tuesday. So the
 * first answer only ever MOVES THE MARK: nothing is raised from it, and the
 * device starts listening from now.
 *
 * WHY THE ROWS REPLACE EACH OTHER. Each job carries a stable `key` from the
 * server - `stems:4812`, `imports:<jobId>` - used verbatim as the notice id.
 * A start and its finish therefore land on the same row with different kinds,
 * and notices.ts treats same-id-different-kind as a NEW event: the row is
 * rewritten in place and the bell rings again, instead of the ring filling up
 * with pairs.
 *
 * WHY POLLING. The only live socket is the per-user Connect hub, and a frame
 * on it reaches only a device that has a stream token open - which a phone
 * sitting in a pocket does not. A small request on a slow timer reaches every
 * signed-in device, which is the whole point of the feature.
 */

/** How often to ask while the app is in front. */
const POLL_MS = 45_000;

/**
 * How many events one answer may carry.
 *
 * A cap rather than a page: if more than this happened since the last look,
 * the older ones are genuinely stale news and the newest are what somebody
 * wants. The mark still moves past all of them, so nothing repeats.
 */
const LIMIT = 25;

/** Where each source's start and finish land in the bell's vocabulary. */
function kindFor(ev: ActivityEvent): string | null {
  // A probe is something the owner pressed a button for, half a second ago,
  // while looking at the answer. A bell row for it is telling somebody what
  // they just did.
  if (ev.kind === 'probe') return null;
  const started = ev.state === 'started';
  switch (ev.source) {
    case 'stems':
      return started ? 'stems-started' : 'stems';
    case 'ai':
      return started ? 'ai-started' : 'ai';
    case 'imports':
      // Only the START, deliberately. The landing already has an owner -
      // DownloadNotices raises it from the queue with the album art on it,
      // which is a better row than anything this feed could build - and two
      // announcements of one arrival is exactly the noise this switch gets
      // blamed for.
      return started ? 'download-started' : null;
    default:
      return null;
  }
}

export function VerboseNotices(): null {
  const { session } = useServerSession();
  /** The newest id already accounted for. -1 means "not seeded yet". */
  const mark = useRef(-1);
  /** Which account the mark belongs to: switching servers must re-seed, or the
   *  new hub's history is announced as though it just happened. */
  const scope = useRef<string | null>(null);

  useEffect(() => {
    if (!session) {
      mark.current = -1;
      scope.current = null;
      return;
    }
    const key = `${session.url}:${session.username}`;
    if (scope.current !== key) {
      scope.current = key;
      mark.current = -1;
    }

    let alive = true;
    const controller = new AbortController();

    const look = async () => {
      // Read at the moment of the poll, not at mount: the switch is a live
      // preference and turning it off should stop the next round, not the
      // round after a remount.
      if (!verboseNoticesEnabled()) return;
      // A backgrounded webview should not be waking the network on a timer;
      // the next foreground tick catches up, because the mark has not moved.
      if (document.visibilityState === 'hidden') return;
      try {
        const page = await fetchActivity(session, Math.max(0, mark.current), LIMIT, controller.signal);
        if (!alive) return;
        if (mark.current < 0) {
          // The seed. Mark the position and say nothing.
          mark.current = page.latestId;
          return;
        }
        for (const ev of page.events) {
          const kind = kindFor(ev);
          if (kind) {
            noteNotice({
              id: ev.key,
              kind,
              title: ev.title,
              body: ev.body,
              // No cover: the feed names work, not songs, and a track id is
              // not worth a second request per row to dress one up.
              art: null,
              // A download's row is the one with somewhere to go.
              door: ev.source === 'imports' ? 'downloads' : null,
              // The server's clock, in seconds; the ring works in ms.
              at: ev.at * 1000,
            });
          }
        }
        // Past everything the server has, not just what this page carried -
        // otherwise a burst larger than LIMIT would be re-read forever.
        mark.current = Math.max(page.latestId, ...page.events.map((e) => e.id), mark.current);
      } catch {
        // A hub that predates /api/activity answers 404, and one that is
        // simply asleep answers nothing. Both are "ask again later" - there is
        // no version of this feature worth showing somebody an error about.
      }
    };

    void look();
    const timer = window.setInterval(() => void look(), POLL_MS);
    // Coming back to the app is the moment somebody is most likely to want the
    // news, and the moment the hidden-tab guard above has been skipping.
    const onShow = () => { if (document.visibilityState === 'visible') void look(); };
    document.addEventListener('visibilitychange', onShow);

    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [session]);

  return null;
}
