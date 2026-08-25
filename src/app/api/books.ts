import { request } from './http.ts';
import type { ServerSession } from './http.ts';

/**
 * What a transcript says about the shape of a reading.
 *
 * Derived on the server from the transcript and cached there, because the
 * source is tens of thousands of lines for a long book and the answer is three
 * numbers. Zeroes mean "nothing found", never "the start of the file" - an
 * offer is only made for a positive one.
 */
export interface BookShape {
  /** Words per minute across the read span. 0 when unknown. */
  wpm: number;
  /** A word for that number: unhurried, measured, steady, brisk, quick. */
  pace: string;
  /** Where the opening card ends and the book begins. 0 when none was found. */
  openingMs: number;
  /** Where the closing credits begin. 0 when none was found. */
  creditsMs: number;
  /** What the card actually says, so an offer can show it rather than asking
   *  somebody to trust a number. */
  openingText: string;
  creditsText: string;
  words: number;
}

/**
 * Shapes for a set of tracks, keyed by id as a string.
 *
 * A missing id is not an error: it means that book has no transcript yet, or
 * has one with nothing worth offering. Both render as silence.
 *
 * Throws ServerError(404) on a hub that predates the route; callers treat that
 * as "not here yet" and show nothing, exactly as they would for a library with
 * no transcripts at all.
 */
export async function fetchBookShapes(
  session: ServerSession,
  ids: number[],
  signal?: AbortSignal,
): Promise<Record<string, BookShape>> {
  if (ids.length === 0) return {};
  const q = new URLSearchParams({ ids: ids.join(',') });
  const reply = await request<{ shapes: Record<string, BookShape> }>(
    session.url,
    `/api/books/shape?${q}`,
    { token: session.token, signal },
  );
  return reply.shapes ?? {};
}
