/*
 * What the shelf says about readings in progress.
 *
 * Kept apart from the page because it is the only part of the transcription
 * panel that can be got WRONG in a way nobody would notice: the panel itself is
 * a list of bars, but these are the numbers under them, and a miscount reads as
 * a confident, plausible lie about how far along a twelve-hour book is.
 *
 * It takes track ids rather than tracks so it owes nothing to the library's
 * path shapes - the page resolves `afm://<id>` before calling in.
 */

export interface TranscribeJob {
  id: string;
  trackId: number;
  title: string;
  /** queued | preparing | transcribing | done | error */
  state: string;
  error: string;
  lines: number;
  queuedAt: number;
}

/** The states that mean "this is still happening". */
export const JOB_ACTIVE = new Set(['queued', 'preparing', 'transcribing']);

/*
 * Which running job best represents the book, when several are in flight.
 *
 * The server hands its queue back NEWEST FIRST, and a sectioned book is queued
 * all at once - so the first active job in the list is the LAST chapter, still
 * waiting its turn. Taking that one would have captioned a book "waiting its
 * turn" while chapter three was being read aloud. Rank instead: the file
 * actually under the recogniser outranks one still in the line.
 */
const LIVELINESS: Record<string, number> = { transcribing: 3, preparing: 2, queued: 1 };

/** A book as this panel needs it: a name, and the files it is made of. */
export interface ProgressBook {
  key: string;
  title: string;
  trackIds: number[];
}

export interface ProgressRow {
  key: string;
  title: string;
  /** Files of this book with a job in the server's current run. */
  total: number;
  done: number;
  failed: number;
  /** The one being worked on now, or null when only failures are left. */
  live: TranscribeJob | null;
}

/**
 * One row per book the server is currently reading.
 *
 * A book that simply FINISHED drops out - "being transcribed" is the question
 * the panel answers, and a completed row would sit there until the server was
 * restarted. A book with failures stays even once nothing of it is running,
 * because the alternative is a reading that silently never happened.
 *
 * `total` counts jobs, not chapters. Queueing a book that is already half
 * transcribed only enqueues the missing files, and calling those "3 of 42"
 * would understate it - what is being reported is this run's work.
 */
export function transcribeRows(jobs: TranscribeJob[], books: ProgressBook[]): ProgressRow[] {
  if (jobs.length === 0) return [];

  const owner = new Map<number, ProgressBook>();
  for (const b of books) {
    for (const id of b.trackIds) owner.set(id, b);
  }

  const byBook = new Map<string, ProgressRow>();
  for (const j of jobs) {
    const book = owner.get(j.trackId);
    // A job for something this device has not synced: nothing to name it with,
    // and a list read by title has no row for a book it cannot name.
    if (!book) continue;
    const row = byBook.get(book.key) ?? {
      key: book.key,
      title: book.title,
      total: 0,
      done: 0,
      failed: 0,
      live: null,
    };
    row.total += 1;
    if (j.state === 'done') row.done += 1;
    else if (j.state === 'error') row.failed += 1;
    else {
      const rank = LIVELINESS[j.state] ?? 0;
      if (rank > 0 && (row.live === null || rank > (LIVELINESS[row.live.state] ?? 0))) row.live = j;
    }
    byBook.set(book.key, row);
  }

  return [...byBook.values()].filter((r) => r.live !== null || r.failed > 0);
}
