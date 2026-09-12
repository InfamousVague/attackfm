import type { MusicImportJob } from '../../plugins/importsBridge.ts';
import type { PlaylistWant } from '../api/playlists.ts';
import { identityKey, leadKey } from '../downloads/identity.ts';

/**
 * Where one of a playlist's arriving songs is, read off the import that is
 * bringing it.
 *
 * A want knows only that it is expected. The job the hub staged the list
 * from knows more - which song it is on, how many it has finished, whether it
 * gave up - and a row that can say "downloading" or "could not find this"
 * is the whole difference between a page you can watch and a page that
 * spins. Nothing here is a second progress system: it is the same
 * per-song reading the queue's own card makes, joined to the wants by the
 * identity every arriving song already carries.
 */

export type WantState =
  /** Expected, and nothing on this device is watching its download. */
  | 'waiting'
  /** In the running job's listing, not reached yet. */
  | 'queued'
  /** The song the job is on right now. */
  | 'downloading'
  /** Its file is down; the hub is filing it into the library and the list. */
  | 'downloaded'
  /** The fetch meant to bring it gave up. */
  | 'failed';

export interface WantProgress {
  state: WantState;
  /** For 'failed': the hub's own words, or 'not found' when nothing could be
   *  found to fetch. */
  reason: string | null;
}

/** The hub's word for a want it looked for and could not find - the one
 *  reason the page translates rather than quotes. Matched, never shown. i18n-ignore */
export const NOT_FOUND = 'not found';

/**
 * The job bringing a playlist's wants, from the queue: the one that carries
 * this list's id. A running one first - a retried import sits beside its
 * failed self until the queue is cleared, and the running one is the truth.
 */
export function importJobFor(
  jobs: readonly MusicImportJob[] | undefined,
  playlistId: string,
): MusicImportJob | null {
  if (!jobs) return null;
  const mine = jobs.filter((j) => typeof j.playlistId === 'number' && String(j.playlistId) === playlistId);
  if (mine.length === 0) return null;
  const live = mine.find((j) => j.state === 'queued' || j.state === 'downloading');
  return live ?? mine[0]!;
}

/**
 * The reading for one want. The want's own mark wins: the hub wrote it at
 * the end of the run, and it outlives the job card, which the queue may have
 * cleared. Then the job: its listing is matched by the same two keys the hub
 * settles on (the exact credit, then the lead credit), so a listing that
 * says "Czarface" still finds the want filed as "CZARFACE, Frankie Pulitzer".
 */
export function wantProgress(want: PlaylistWant, job: MusicImportJob | null): WantProgress {
  if (want.error) return { state: 'failed', reason: want.error };
  if (!job) return { state: 'waiting', reason: null };
  if (job.state === 'error') return { state: 'failed', reason: job.error || null };
  const items = job.items ?? [];
  let index = items.findIndex((i) => identityKey(i.artist, i.title) === want.k);
  if (index < 0) {
    const lead = leadKey(want.artist, want.title);
    index = items.findIndex((i) => leadKey(i.artist, i.title) === lead);
  }
  if (index < 0) return { state: 'waiting', reason: null };
  if (job.state === 'done' || index < job.completed) return { state: 'downloaded', reason: null };
  if (job.state === 'downloading' && index === job.completed) return { state: 'downloading', reason: null };
  return { state: 'queued', reason: null };
}
