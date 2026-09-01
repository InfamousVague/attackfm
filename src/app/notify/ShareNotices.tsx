import { useEffect, useRef } from 'react';
import { fetchShares } from '../servers/registry.ts';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { dismissNotice, noteNotice } from './notices.ts';

/**
 * A friend sent you a song, in the bell.
 *
 * The same shape as FriendNotices, and separate from it for the same reason
 * it is separate from the activity watcher: this is addressed to you and
 * waits for an answer, so it rings whether or not verbose is on, and it is a
 * STANDING STATE - a song still waiting on the Friends page is still news on
 * a fresh install.
 *
 * Two kinds of row, one per song and one per SENDER: the first song from
 * anyone arrives as "wants to send you songs", because the registry holds it
 * until you say you take songs from that person at all (see the share grants
 * on the Friends page). Once you have, their songs show by name.
 *
 * Nothing here fetches music. "Get it" on the Friends page asks your OWN hub
 * for the song by name (a pending like), which is the only way a song ever
 * enters a library.
 */

const POLL_MS = 90_000;

const raised = new Set<string>();

export function ShareNotices() {
  const registry = useRegistryOptional();
  const session = registry?.session ?? null;
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!session) {
      for (const id of raised) dismissNotice(id);
      raised.clear();
      return;
    }

    let alive = true;
    const look = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const inbox = await fetchShares(session.token);
        if (!alive) return;
        const open = new Set<string>();
        const askedAbout = new Set<string>();
        for (const s of inbox) {
          if (s.allowed === null) {
            // One row per sender, not per song: the question is about them.
            if (askedAbout.has(s.from)) continue;
            askedAbout.add(s.from);
            const id = `shares:ask:${s.from}`;
            open.add(id);
            raised.add(id);
            noteNotice({
              id,
              kind: 'friends',
              title: `@${s.from} wants to send you songs`,
              body: 'Open Friends to say whether you take them.',
              art: null,
              door: 'friends',
              at: s.createdAt * 1000,
            });
            continue;
          }
          if (s.allowed === false) continue;
          const id = `shares:${s.id}`;
          open.add(id);
          raised.add(id);
          noteNotice({
            id,
            kind: 'friends',
            title: `@${s.from} sent you ${s.title}`,
            body: `${s.artist}${s.note ? ` · “${s.note}”` : ''} — open Friends to get it.`,
            art: null,
            door: 'friends',
            at: s.createdAt * 1000,
          });
        }
        // Taken or put away, here or on another device.
        for (const id of [...raised]) {
          if (!open.has(id)) {
            dismissNotice(id);
            raised.delete(id);
          }
        }
      } catch {
        // The registry being unreachable is not news; the next tick tries again.
      }
    };

    void look();
    timer.current = window.setInterval(() => void look(), POLL_MS);
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
