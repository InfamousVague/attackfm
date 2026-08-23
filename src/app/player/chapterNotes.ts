import { sessionForOrigin } from '../servers/sessions.ts';
import { request } from '../api/http.ts';
import { originFromPath, trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * What each chapter of a book is called and is about, said by the hub's AI.
 *
 * The hub reads a chapter's transcript opening and answers with a truthful
 * name (a preamble mislabelled "Chapter 1" gets called a preamble) and one
 * non-spoiler line. This module only FETCHES: one request per opened book,
 * answered for the whole book at once and keyed by track id - a single-file
 * book's notes index its chapter marks, a sectioned book has one note per
 * section at idx 0.
 *
 * Same shape and rules as `transcript.ts` next door: asked when a book is
 * opened, never part of a library payload, and a miss caches too - a book
 * whose hub has no AI should not be asked again every render.
 */

export interface ChapterNote {
  idx: number;
  name: string;
  blurb: string;
}

/** Notes for a whole book, keyed by track id (as the server sends it). */
export type BookNotes = Record<string, ChapterNote[]>;

const cache = new Map<number, Promise<BookNotes | null>>();

export function fetchChapterNotes(track: Track): Promise<BookNotes | null> {
  if (track.kind !== 'book') return Promise.resolve(null);
  const id = trackIdFromPath(track.path);
  if (id == null) return Promise.resolve(null);
  const held = cache.get(id);
  if (held) return held;

  const session = sessionForOrigin(originFromPath(track.path));
  if (!session) return Promise.resolve(null);

  const looked = request<{ blurbs: BookNotes }>(session.url, `/api/audiobooks/blurbs/${id}`, {
    token: session.token,
  })
    .then((r) => {
      const blurbs = r.blurbs ?? {};
      return Object.keys(blurbs).length > 0 ? blurbs : null;
    })
    .catch(() => null);

  cache.set(id, looked);
  return looked;
}

/** Forget one book, so notes written since (a fresh transcription, a sweep)
 *  are picked up without a reload. */
export function forgetChapterNotes(track: Track): void {
  const id = trackIdFromPath(track.path);
  if (id != null) cache.delete(id);
}
