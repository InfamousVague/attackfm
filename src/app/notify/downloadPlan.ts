//! What a change in the download queue should DO, as one pure function.
//!
//! This is the half of the notification work that was hardest to be sure of and
//! easiest to get silently wrong, so it is deliberately separated from the
//! component that performs it. Everything here is arithmetic over two
//! snapshots: no React, no store, no clock of its own - `now` is a parameter -
//! which means it can be exercised directly rather than reasoned about.
//!
//! That separation is not tidiness. The first version of this logic lived
//! inline in the effect and compared a unix-SECONDS timestamp from the server
//! against a millisecond duration, so its freshness test was false forever and
//! every download that finished while the app was backgrounded was dropped on
//! the floor - the exact case the feature exists for. It type-checked, it
//! built, and the store's own tests passed, because they exercised the ring
//! rather than the decision about what to put in it.

import { msOf } from './notices.ts';
import type { MusicImportJob, MusicImportState } from '../../plugins/importsBridge.ts';

/**
 * How recently a job must have been raised for an unseen LANDING to count as
 * news.
 *
 * The idle poll runs about once a minute, so a single track can be queued and
 * finished inside one gap - genuine news that must not be swallowed. Anything
 * older is another device's history catching us up, and is taken as read.
 */
export const FRESH_WINDOW_MS = 5 * 60 * 1000;

/**
 * How recently a job must have been raised for its APPEARANCE to be a start
 * worth a toast.
 *
 * Tighter than the landing window, because the two answer different questions.
 * A landing is news whenever it happens; a "downloading…" line is only an
 * answer to something you just pressed, and a queue that was already running
 * when the app launched has not started, it has resumed.
 */
export const START_WINDOW_MS = 60_000;

/** One row the ring should be given. */
export interface PlannedNotice {
  id: string;
  kind: 'drops' | 'failed';
  title: string;
  body: string;
  artUrl: string | null;
  door: 'downloads';
}

export interface Plan {
  /** Jobs whose beginning deserves a quick line at the top. */
  started: MusicImportJob[];
  /** Rows for the ring, in queue order. */
  notices: PlannedNotice[];
  /** How many landed this tick - one buzz for the tick, not one per song. */
  landed: number;
}

export const EMPTY_PLAN: Plan = { started: [], notices: [], landed: 0 };

/**
 * A finished job that put nothing new on the shelf.
 *
 * Re-importing a record you already own runs to `done` having filed no files
 * and skipped every track. The server checks the same thing before it pushes -
 * "a job that found every track already owned landed nothing" - and stays
 * quiet, so this stays quiet too, rather than announcing a download that never
 * happened.
 *
 * Gated on the SKIP as well as the empty file list, deliberately: a transport
 * that never populates `files` would otherwise have all its real landings
 * swallowed, which is the same shape of silent loss as the seconds-versus-
 * milliseconds bug this module was split out to prevent.
 */
export function silentLanding(job: MusicImportJob): boolean {
  return (job.files?.length ?? 0) === 0 && (job.skipped ?? 0) > 0;
}

/**
 * The line a landing reads, mirroring what the server's own push says for the
 * same event (`server/src/imports.rs`) so the two never describe one arrival in
 * two different sentences.
 */
export function landedLine(job: MusicImportJob): string {
  const n = job.files?.length ?? 0;
  if (n > 1) return `${n} songs are in your library.`;
  if (job.title) return `“${job.title}” is in your library.`;
  return 'It is in your library.';
}

/**
 * Compare the queue as it was against the queue as it is.
 *
 * `previous` is null when nothing has been seen yet, which is NOT the same as
 * an empty queue and is why the caller must not seed on one: the provider
 * starts at `[]` and fills it from an async poll, so a seed taken there is
 * spent on a snapshot that says nothing about the server, and the first real
 * queue then arrives with every job unseen - announcing work begun before the
 * app was running as if it had just started.
 *
 * THE SEED STILL ANSWERS FOR WORK THAT JUST BEGAN. Refusing to say anything at
 * all on the first real snapshot is how the first download of a session went
 * silent: on a new account, or after Clear finished, the queue is empty at
 * launch and stays empty, so nothing seeds - and then `enqueue` inserts the
 * job you just asked for optimistically, ahead of any poll, making YOUR press
 * the first thing this ever sees. Swallowing it wholesale ate the one answer
 * the app gives for pressing the button.
 *
 * So a seed reports STARTS, filtered by the same age gate the steady state
 * uses, and reports nothing else. Landings and failures stay silent on the
 * first look, because those are the ones a shared queue is full of and the
 * ones there is no way to tell apart from history.
 */
export function planFromQueue(
  previous: ReadonlyMap<string, MusicImportState> | null,
  jobs: readonly MusicImportJob[],
  now: number,
): Plan {
  if (previous === null) {
    return {
      started: jobs.filter(
        (j) =>
          (j.state === 'queued' || j.state === 'downloading') &&
          now - msOf(j.createdAt) < START_WINDOW_MS,
      ),
      notices: [],
      landed: 0,
    };
  }

  const started: MusicImportJob[] = [];
  const notices: PlannedNotice[] = [];
  let landed = 0;

  for (const job of jobs) {
    const was = previous.get(job.id);
    if (was === job.state) continue;

    // `createdAt` arrives in unix SECONDS from the server. Through msOf, or
    // every comparison below is false against a number a thousandfold too small.
    const age = now - msOf(job.createdAt);
    const running = job.state === 'queued' || job.state === 'downloading';

    if (
      // Unseen, or coming back from a failure: pressing Retry is the one start
      // a person explicitly asked for, and it deserves the same answer the
      // first attempt got.
      (was === undefined || was === 'error') &&
      running &&
      age < START_WINDOW_MS
    ) {
      started.push(job);
    } else if (job.state === 'done') {
      // A job never seen start can still be news - see FRESH_WINDOW_MS - but a
      // job that filed nothing never is.
      if (!silentLanding(job) && (was !== undefined || age < FRESH_WINDOW_MS)) {
        landed += 1;
        notices.push({
          id: `import:${job.id}`,
          kind: 'drops',
          title: 'New music',
          body: landedLine(job),
          artUrl: job.artworkUrl,
          door: 'downloads',
        });
      }
    } else if (job.state === 'error' && (was !== undefined || age < FRESH_WINDOW_MS)) {
      // The same freshness gate the landing carries. Failures sit in the
      // server's queue until somebody clears them, so without it every old
      // failure is re-announced on each launch - including ones already read
      // and cleared, which would come back from a ring that no longer holds
      // them.
      notices.push({
        // The same id a landing would use, so fail → retry → fail replaces its
        // own row rather than stacking three identical complaints. The ring
        // treats a change of KIND as a different event, so a retry that finally
        // lands still rings.
        id: `import:${job.id}`,
        kind: 'failed',
        title: 'Download failed',
        body: job.title ? `“${job.title}” didn’t finish.` : 'A download didn’t finish.',
        artUrl: job.artworkUrl,
        door: 'downloads',
      });
    }
  }

  return { started, notices, landed };
}

/** The queue as a state map, for the next comparison. */
export function snapshotOf(jobs: readonly MusicImportJob[]): Map<string, MusicImportState> {
  return new Map(jobs.map((j) => [j.id, j.state] as const));
}
