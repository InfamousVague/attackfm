import { useEffect, useRef } from 'react';
import { fetchFriends as fetchRegistryFriends } from '../servers/registry.ts';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { dismissNotice, noteNotice } from './notices.ts';

/**
 * Somebody asked to be friends, in the bell.
 *
 * The `friends` notice kind has existed since the ring did - it is in the
 * settings list, it has an icon - and nothing ever raised one. The only way to
 * find out that somebody had asked was to open the Friends page and look, which
 * is the one thing a notification exists to save you from.
 *
 * NOT PART OF THE VERBOSE WATCHER, and the distinction is the whole reason this
 * is its own file. That one turns the server's ACTIVITY feed - stems finishing,
 * imports landing - into rows, and it is behind the device's "verbose" switch
 * because it is chatter about work the machine is doing. A friend request is
 * not chatter and is not about the machine: it is addressed to you personally
 * and waits for an answer. It rings whether or not verbose is on.
 *
 * A STANDING STATE, NOT AN EVENT, which is why this does not seed the way the
 * activity watcher does. That one deliberately says nothing about its first
 * answer, because a week of finished jobs is stale news. A request that is
 * still pending is not stale - it is a question nobody has answered - so a
 * fresh install with three of them waiting shows all three.
 *
 * Re-raising is free: the notice id is the request's own id, and noteNotice
 * treats a repeat of the same id and kind as the same event, so a poll every
 * minute does not ring a bell every minute.
 */

/** Slower than the activity feed. A friend request is not urgent to the
 *  second, and this is a whole extra request per device per tick. */
const POLL_MS = 90_000;

/** Notice ids this watcher has raised, so one that gets ANSWERED - accepted or
 *  declined, here or on another device - has its row taken away again rather
 *  than sitting in the ring as a question that no longer exists. */
const raised = new Set<string>();

export function FriendNotices() {
  // Friend requests land on the REGISTRY (attack.fm), where friends live;
  // this used to poll the hub's own table, which nothing fills - so it never
  // fired for anyone.
  const registry = useRegistryOptional();
  const session = registry?.session ?? null;
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!session) {
      // Signed out: nothing to ask, and the rows belong to an account that is
      // no longer the one looking at the screen.
      for (const id of raised) dismissNotice(id);
      raised.clear();
      return;
    }

    let alive = true;
    const look = async () => {
      // A backgrounded webview should not be waking the network on a timer;
      // a pending request is still pending when it comes back.
      if (document.visibilityState === 'hidden') return;
      try {
        const feed = await fetchRegistryFriends(session.token);
        if (!alive) return;
        const open = new Set<string>();
        for (const ask of feed.incoming) {
          const id = `friends:${ask.id}`;
          open.add(id);
          raised.add(id);
          noteNotice({
            id,
            kind: 'friends',
            title: `@${ask.handle} wants to be friends`,
            body: 'Open Friends to answer.',
            art: null,
            door: 'friends',
            at: Date.now(),
          });
        }
        // Answered elsewhere, or by you on another device.
        for (const id of [...raised]) {
          if (!open.has(id)) {
            dismissNotice(id);
            raised.delete(id);
          }
        }
      } catch {
        // A hub that cannot be reached is not news; the next tick tries again.
      }
    };

    void look();
    timer.current = window.setInterval(() => void look(), POLL_MS);
    // A phone brought back to the front should not wait out the rest of a
    // ninety-second tick to find out somebody asked.
    const onWake = () => void look();
    document.addEventListener('visibilitychange', onWake);
    return () => {
      alive = false;
      document.removeEventListener('visibilitychange', onWake);
      if (timer.current != null) window.clearInterval(timer.current);
    };
  }, [session]);

  return null;
}
