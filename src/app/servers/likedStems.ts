import { useEffect, useState } from 'react';
import { request } from '../api/http.ts';
import { useServerSession } from './serverSession.tsx';

/**
 * Whether Liked is separated ahead of time - readable from anywhere.
 *
 * Every other "separate these ahead" switch belongs to a playlist and rides on
 * that playlist's own row, so the tile menu already has the answer in hand.
 * Liked has no row: it is not a playlist, it is a slice of the library, and the
 * server keeps its answer as a single preference (`stems.liked`). Without this
 * the only place that knew the value was the settings pane that polls for it,
 * which is the wrong dependency for a menu on the Home screen.
 *
 * Read ONCE per session and cached at module scope, deliberately: a menu item's
 * label is not worth a poll, and the value only ever changes because somebody
 * in this app changed it - so a write updates the cache and every mounted
 * listener with it. A second device flipping the switch will be a beat stale
 * here until the next launch, which is the correct trade for a preference
 * nobody touches twice in a sitting.
 */

/** null = not asked yet; undefined = asked, and there is nothing to offer -
 *  no demucs on the box, a build from before Liked became opt-in, or a
 *  listener rather than the operator (separating spends the SERVER's GPU and
 *  disk, so the server lets only an admin ask for it; an item that springs
 *  back when a listener taps it is worse than no item). */
let cached: boolean | null | undefined = null;
const listeners = new Set<(v: boolean | undefined) => void>();

function publish(v: boolean | undefined) {
  cached = v;
  for (const fn of listeners) fn(v);
}

export function useLikedStems(): {
  /** undefined while unknown, or on a server that cannot separate at all. */
  liked: boolean | undefined;
  setLiked: (on: boolean) => Promise<void>;
} {
  const { session } = useServerSession();
  const [liked, setState] = useState<boolean | undefined>(cached ?? undefined);

  useEffect(() => {
    listeners.add(setState);
    return () => void listeners.delete(setState);
  }, []);

  useEffect(() => {
    if (!session || !session.isAdmin || cached !== null) return;
    // Marked as asked before the answer lands, so several tiles mounting
    // together ask once between them rather than once each.
    cached = undefined;
    void (async () => {
      try {
        const next = await request<{ liked?: boolean; available: boolean }>(
          session.url,
          '/api/stems/prefetch',
          { token: session.token },
        );
        publish(next.available ? next.liked : undefined);
      } catch {
        publish(undefined);
      }
    })();
  }, [session]);

  const setLiked = async (on: boolean) => {
    if (!session) return;
    // Optimistic, and left that way on success: the server's answer is the one
    // we just sent it, and re-reading only to be told so is a round trip the
    // menu has already closed before.
    publish(on);
    try {
      await request(session.url, '/api/stems/prefetch/liked', {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({ enabled: on }),
      });
    } catch {
      publish(!on);
    }
  };

  return { liked, setLiked };
}
