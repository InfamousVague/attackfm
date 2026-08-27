import { useEffect, useMemo, useState } from 'react';
import { fetchCollectorStatus, type CollectorStatus } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useLibrary } from './library.tsx';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * The auditions that are actually YOURS, and the collector's ledger with them.
 *
 * `useLibrary().forYou` is every unadopted audition this client has in its
 * store, which is not the same thing. The server no longer sends other
 * listeners' auditions, but a client that synced before it stopped still holds
 * them: the library sync is a delta over `rev`, and a row that simply stops
 * being sent is never withdrawn - only a tombstone removes one. So a device
 * that was around for the leak keeps showing it.
 *
 * That is exactly the bug this exists to prevent a second time. ForYouShelf
 * had the owner filter and the Music Date chip did not, so the shelf said 220
 * and the chip said 767 on the same screen, both from the same array. One
 * definition, used by both.
 */
export function useMyAuditions(): { mine: Track[]; status: CollectorStatus | null } {
  const { forYou } = useLibrary();
  const { session } = useServerSession();
  // Pull-to-refresh re-runs the fetch below - see nav/pageRefresh.tsx.
  const refreshNonce = useRefreshNonce();
  const [status, setStatus] = useState<CollectorStatus | null>(null);

  // Refreshed when the quarantine changes size - a landing, an adoption or a
  // pass is exactly when the ledger moved.
  useEffect(() => {
    if (!session) {
      setStatus(null);
      return;
    }
    const ctrl = new AbortController();
    void fetchCollectorStatus(session, ctrl.signal)
      .then(setStatus)
      .catch(() => {
        // An older server has no collector; callers simply show nothing.
      });
    return () => ctrl.abort();
  }, [session, forYou.length, refreshNonce]);

  const mine = useMemo(() => {
    // No status means no answer about who you are, and the safe reading of
    // that is NONE rather than ALL: showing somebody else's auditions is the
    // failure this is here to avoid, and an empty shelf is the mild one.
    if (!status) return [];
    return forYou
      .filter((t) => t.curatorUserId === status.userId)
      .sort((a, b) => b.addedAt - a.addedAt);
  }, [forYou, status]);

  return { mine, status };
}
