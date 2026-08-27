import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { fetchCollectorStatus, type CollectorStatus } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useLibrary } from './library.tsx';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import { passedSet, passedVersion, subscribePassed } from '../date/datePassed.ts';
import { trackIdFromPath } from '../server.ts';
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
 *
 * The definition did not go far enough, and the same bug came back wearing a
 * different number: the chip said "172 waiting" over a Music Date that opened
 * on its empty state. Owner was the only filter here, but a song stops
 * auditioning for two more reasons - you PASSED it (remembered in the ledger,
 * across launches) or you KEPT it (which is what a heart means here). Both are
 * verdicts, and a song that has had a verdict is not waiting for one.
 *
 * So this is the deck, and Music Date's own deck is now this list minus the
 * cards judged in the current sitting. A counter somewhere else in the app
 * cannot drift from the room it opens, because there is nothing else to
 * count.
 */
export function useMyAuditions(): { mine: Track[]; status: CollectorStatus | null } {
  const { forYou, isFavorite } = useLibrary();
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

  // Passes are remembered across launches, so the count has to move when one
  // is written - otherwise it only corrects itself on the next full reload,
  // which is precisely how it came to claim 172 over an empty deck.
  useSyncExternalStore(subscribePassed, passedVersion, passedVersion);

  const mine = useMemo(() => {
    // No status means no answer about who you are, and the safe reading of
    // that is NONE rather than ALL: showing somebody else's auditions is the
    // failure this is here to avoid, and an empty shelf is the mild one.
    if (!status) return [];
    const passed = passedSet();
    return forYou
      .filter((t) => t.curatorUserId === status.userId)
      .filter((t) => !isFavorite(t.path))
      .filter((t) => {
        const id = trackIdFromPath(t.path);
        return id === null || !passed.has(id);
      })
      .sort((a, b) => b.addedAt - a.addedAt);
    // passedVersion is not read here, but a change to it must recompute this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forYou, status, isFavorite, passedVersion()]);

  return { mine, status };
}
