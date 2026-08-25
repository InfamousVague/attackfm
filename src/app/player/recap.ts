import { sessionForOrigin } from '../servers/sessions.ts';
import { request, ServerError } from '../api/http.ts';
import { originFromPath, trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * "Catch me up" - what has happened in this book, up to where you stopped.
 *
 * The hub does all of it: the spoiler bound is enforced there, over stored
 * chapter summaries whose windows END before your bookmark, so nothing from
 * past the mark is ever sent to a model, let alone to this file. The client's
 * whole job is to ask, wait, and show the answer.
 *
 * Same rules as `chapterNotes.ts` next door - asked for one book, never part
 * of a library payload - with one difference that matters: this is NOT
 * cached here. A recap is about a moving position, the server already keeps
 * the last one per reader per book and hands it straight back when the mark
 * has not moved, and a second cache in front of that would serve last week's
 * place today.
 */

export interface CatchUp {
  ready: true;
  /** Short paragraphs, oldest first. */
  recap: string[];
  /** Where things stand: open questions, unresolved situations. */
  threads: string[];
  upto: { ms: number; label: string; chapters: number };
  /** Answered from the hub's own store rather than written just now. */
  cached: boolean;
  /** Kept from before because the model could not answer this time. */
  stale?: boolean;
  /** The earliest chapters did not fit and were left out. */
  clipped?: boolean;
}

/** Why there is nothing to show - each one says something different to a
 *  reader, so they stay distinct rather than collapsing into "unavailable". */
export type NotReady =
  | 'no-model'
  | 'no-transcript'
  | 'reading'
  | 'at-the-start'
  | 'model-silent'
  | 'not-a-book'
  | 'old-server'
  | 'offline';

export type RecapAnswer = CatchUp | { ready: false; reason: NotReady };

/**
 * Ask for the catch-up on one book file.
 *
 * `ms` is where the player thinks it is; omitted, the hub uses its own ledger,
 * which is the case this exists for - a book untouched for three weeks, opened
 * from the shelf, not yet playing.
 */
export async function fetchCatchUp(
  track: Track,
  ms?: number,
  fresh = false,
): Promise<RecapAnswer> {
  if (track.kind !== 'book') return { ready: false, reason: 'not-a-book' };
  const id = trackIdFromPath(track.path);
  if (id == null) return { ready: false, reason: 'offline' };
  const session = sessionForOrigin(originFromPath(track.path));
  if (!session) return { ready: false, reason: 'offline' };

  const q = new URLSearchParams();
  if (ms != null && ms > 0) q.set('ms', String(Math.round(ms)));
  if (fresh) q.set('fresh', '1');
  const tail = q.toString() ? `?${q}` : '';

  try {
    const answer = await request<RecapAnswer>(session.url, `/api/audiobooks/recap/${id}${tail}`, {
      token: session.token,
      // A local model writing several paragraphs is slower than any ordinary
      // request on this app, and the default deadline would call a working
      // box broken. The reader is looking at a spinner they asked for.
      timeoutMs: 180_000,
    });
    if (answer && answer.ready) return answer;
    return { ready: false, reason: (answer as { reason?: NotReady })?.reason ?? 'model-silent' };
  } catch (err) {
    // A hub that predates this feature answers 404, and "cannot reach the
    // server" would be a lie about a server that answered immediately. The
    // app ships ahead of the hubs it talks to, so this is ordinary.
    if (err instanceof ServerError && err.status === 404) {
      return { ready: false, reason: 'old-server' };
    }
    return { ready: false, reason: 'offline' };
  }
}

/** What to put on screen when there is no recap. Phrased as the reader's
 *  situation rather than the machine's, because every one of these is a
 *  perfectly ordinary state for a hub to be in. */
export function whyNot(reason: NotReady): string {
  switch (reason) {
    case 'at-the-start':
      return 'Nothing to catch up on yet - you are at the beginning.';
    case 'reading':
      return 'The hub is still reading this book. Try again a little later.';
    case 'no-transcript':
      return 'This book has not been transcribed yet, so there is nothing to read back.';
    case 'no-model':
      return 'No AI model is set up on this server, so nobody can write the recap.';
    case 'model-silent':
      return 'The model did not answer this time. Try again in a moment.';
    case 'not-a-book':
      return 'Recaps are for audiobooks.';
    case 'old-server':
      return 'This server is older than the app and does not write recaps yet.';
    case 'offline':
      return 'Cannot reach the server this book came from.';
  }
}
