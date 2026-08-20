import { useEffect, useRef, useSyncExternalStore } from 'react';
import { trackIdFromPath } from '../api/library.ts';
import { useLibrary } from '../library/library.tsx';
import { usePlaylists } from '../playlists/playlists.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { forgetPlan, markFiled, plansSnapshot, subscribePlans, type FilePlan } from './filePlan.ts';

/**
 * Files finished downloads where they were asked to go, then says so.
 *
 * Mounted once, app-level, and deliberately NOT inside Discover. The download
 * outlives the page that started it: you add a song, walk off to your library,
 * and the import lands ten minutes later with the plugin page long unmounted.
 * A watcher that lives on the page that made the promise is a watcher that is
 * gone when the promise comes due.
 *
 * WAITING FOR THE LIBRARY IS THE HARD PART, and it is why this is a subscription
 * rather than a `.then()` on the enqueue. A job reaching `done` means the file
 * is downloaded, not that the app can see it: the hub indexes it, the library
 * syncs, and only then does a path exist to put in a playlist. Playlists and
 * favourites are keyed by PATH; the job knows server track IDS. So the plan
 * stays owed until the two can be joined, and every library change is a fresh
 * chance to join them.
 */
export function useFilePlan(onArrive: (plan: FilePlan) => void): void {
  const plans = useSyncExternalStore(subscribePlans, plansSnapshot, plansSnapshot);
  const downloads = useDownloadsOptional();
  const { tracks, isFavorite, toggleFavorite } = useLibrary();
  const { addTrack, playlists } = usePlaylists();

  // Held in a ref so the effect can call the newest one without re-running on
  // every render of whoever passed it.
  const arrive = useRef(onArrive);
  arrive.current = onArrive;

  useEffect(() => {
    if (plans.length === 0) return;
    const jobs = downloads?.jobs ?? [];

    for (const plan of plans) {
      if (plan.filed) continue;
      const job = jobs.find((j) => j.id === plan.jobId);

      // The job is gone from the list entirely - cancelled, or old enough to
      // have been swept. Nothing is owed and nothing can be recovered.
      if (!job) {
        forgetPlan(plan.jobId);
        continue;
      }
      if (job.state === 'error') {
        // The song never arrived. Dropping the plan rather than keeping it is
        // the honest choice: a retry makes a NEW job, and this one's promise
        // cannot be kept by it.
        forgetPlan(plan.jobId);
        continue;
      }
      if (job.state !== 'done') continue;

      const ids = job.trackIds ?? [];
      if (ids.length === 0) {
        // A transport that does not report ids - the local desktop engine, or
        // an older server. There is nothing to join on, so the song lands in
        // the library and the plan is dropped rather than waiting forever.
        forgetPlan(plan.jobId);
        continue;
      }

      const wanted = new Set(ids);
      const landed = tracks.filter((t) => {
        const id = trackIdFromPath(t.path);
        return id !== null && wanted.has(id);
      });
      // Still syncing. Come back on the next library change.
      if (landed.length === 0) continue;

      if (plan.dest.kind === 'liked') {
        // toggleFavorite is a TOGGLE, so a song already liked would be
        // un-liked by filing it - the exact opposite of what was asked.
        for (const t of landed) if (!isFavorite(t.path)) toggleFavorite(t.path);
      } else {
        const list = playlists.find((p) => p.id === (plan.dest as { id: string }).id);
        // The playlist was deleted between the ask and the arrival. The song
        // is in the library, which is the part that can still be honoured.
        if (list) for (const t of landed) addTrack(list.id, t.path);
      }

      markFiled(plan.jobId);
      arrive.current(plan);
      // One arrival per pass: two songs landing together should not race two
      // navigations, and the next will be picked up on the following change.
      break;
    }
  }, [plans, downloads, tracks, isFavorite, toggleFavorite, addTrack, playlists]);
}
