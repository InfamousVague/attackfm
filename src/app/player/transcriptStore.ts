/*
 * Transcripts kept on the device.
 *
 * The in-memory cache in `transcript.ts` answers a screen redraw; this answers
 * a dead hub. A book you have kept offline is not much use without its words -
 * the read-along is the reason a lot of people transcribe at all - and words are
 * the one part of a kept book that was still being fetched every time.
 *
 * THE CACHE API, not localStorage. A worded eighteen-hour book is megabytes of
 * JSON: localStorage is a synchronous few-megabyte box shared with every
 * setting the app owns, and filling it would take the settings down with it.
 * The same store art uses, for the same reasons.
 */

import type { BookLine } from './transcript.ts';

const CACHE = 'attackfm-transcripts-v1';

/** A URL only because the Cache API insists on one; nothing ever requests it. */
function keyFor(trackId: number): string {
  return `https://transcripts.attackfm.local/${trackId}`;
}

function store(): Promise<Cache> | null {
  if (typeof caches === 'undefined') return null;
  try {
    return caches.open(CACHE);
  } catch {
    return null;
  }
}

/** Write one track's words down. Quiet: a transcript that will not store is one
 *  that gets fetched again, which is not worth interrupting anybody over. */
export async function keepTranscript(trackId: number, lines: BookLine[]): Promise<boolean> {
  const cache = store();
  if (!cache) return false;
  try {
    const body = JSON.stringify(lines);
    await (await cache).put(
      keyFor(trackId),
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    );
    return true;
  } catch {
    return false;
  }
}

/** The words held for one track, or null. */
export async function keptTranscript(trackId: number): Promise<BookLine[] | null> {
  const cache = store();
  if (!cache) return null;
  try {
    const hit = await (await cache).match(keyFor(trackId));
    if (!hit) return null;
    const parsed: unknown = await hit.json();
    return Array.isArray(parsed) ? (parsed as BookLine[]) : null;
  } catch {
    return null;
  }
}

export async function hasTranscript(trackId: number): Promise<boolean> {
  const cache = store();
  if (!cache) return false;
  try {
    return (await (await cache).match(keyFor(trackId))) !== undefined;
  } catch {
    return false;
  }
}

export async function forgetKeptTranscript(trackId: number): Promise<void> {
  const cache = store();
  if (!cache) return;
  try {
    await (await cache).delete(keyFor(trackId));
  } catch {
    /* nothing to do about it */
  }
}

/** For the storage pane: how many books have their words on this device. */
export async function keptTranscriptCount(): Promise<number> {
  const cache = store();
  if (!cache) return 0;
  try {
    return (await (await cache).keys()).length;
  } catch {
    return 0;
  }
}
