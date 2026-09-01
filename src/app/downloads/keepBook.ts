/*
 * A whole book on the device - audio AND words.
 *
 * The cache already keeps books, but by the same rules it keeps everything
 * else: a rolling budget, ranked by how likely you are to want it, evicted from
 * the cold end. That is right for music and wrong for a book, because a book is
 * one object twenty hours long that you are halfway through - the far end of it
 * is exactly the part the ranking calls cold, and it is the part you will want
 * on the train tomorrow.
 *
 * So this is a stated keep, for the whole thing at once. Every file is pinned
 * the way a hand-pinned song is - `markPinned` puts a key outside the cache's
 * ownership, so the sweep will neither requalify nor evict it - and the
 * transcript is written down beside it, because a kept book without its words
 * loses the read-along, which is why most of these were transcribed at all.
 */

import { fetchTranscript } from '../player/transcript.ts';
import { estimateBytes, extFor, wantedQuality } from '../cache/cacheQuality.ts';
import { cacheQualityKbps, markPinned } from '../cache/cacheStore.ts';
import { isHeld, pinTrack, unpinTrack, vaultKey } from './offline.ts';
import { streamUrl, trackIdFromPath, transcodeUrl } from '../server.ts';
import type { ServerSession } from '../server.ts';
import type { Track } from '../core/tauri.ts';

export interface KeepStep {
  /** Files finished, of `total` - the number a progress bar wants. */
  done: number;
  total: number;
  failed: number;
  /** Set once the audio is in and the words are being fetched. */
  words?: boolean;
}

/**
 * Keep every file of one book, then its words.
 *
 * Sequential on purpose. Fifty parallel downloads on a phone is how you get a
 * queue of timeouts and a hub with fifty transcodes in flight; and a book is
 * read in order, so the file you want first is the one that arrives first.
 */
export async function keepBook(
  session: ServerSession,
  tracks: readonly Track[],
  onStep?: (step: KeepStep) => void,
  signal?: AbortSignal,
): Promise<{ kept: number; failed: number }> {
  const total = tracks.length;
  let done = 0;
  let failed = 0;
  const kbps = cacheQualityKbps();

  for (const track of tracks) {
    if (signal?.aborted) break;
    const id = trackIdFromPath(track.path);
    if (id === null) {
      failed += 1;
      done += 1;
      onStep?.({ done, total, failed });
      continue;
    }
    try {
      const quality = wantedQuality(track, kbps);
      const url =
        quality === 0
          ? streamUrl(session, id)
          : transcodeUrl(session, id, quality, 0, null, null, null);
      // The same guard a hand-pinned song gets: a stalled encode's `.part` has
      // no quality in its name, so a lossless keep would resume onto the head of
      // an AAC fragment and append FLAC to it. Only when nothing complete is
      // held - a finished file is never thrown away.
      if (quality === 0 && !isHeld(track.path)) await unpinTrack(track.path);
      const kept = await pinTrack(track, url, {
        ext: extFor(track, quality),
        minBytes:
          quality !== 0 && track.duration
            ? Math.floor(estimateBytes(track, quality, 0) * 0.5)
            : 0,
      });
      // Only on success. A mark for a download that failed protects a file that
      // is not there, and hides it from the count that would have said so.
      if (kept) markPinned(vaultKey(track.path));
      else failed += 1;
    } catch {
      // One section failing is not the book failing: the rest are still worth
      // having, and the count says how many did not make it.
      failed += 1;
    }
    done += 1;
    onStep?.({ done, total, failed });
  }

  // The words, after the audio. `fetchTranscript` writes its answer to the
  // device itself, so this is the fetch AND the keep; a book nobody has
  // transcribed simply answers null and costs one request.
  if (!signal?.aborted) {
    onStep?.({ done, total, failed, words: true });
    for (const track of tracks) {
      if (signal?.aborted) break;
      try {
        await fetchTranscript(track);
      } catch {
        /* a book with no words is still a kept book */
      }
    }
  }

  return { kept: total - failed, failed };
}
