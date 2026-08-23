import type { LyricLine } from '@glacier/react';
import { sessionForOrigin } from '../servers/sessions.ts';
import { request } from '../api/http.ts';
import { originFromPath, trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * A book's words, timed, so they can be read along with the reading.
 *
 * The server made these ahead of time (see `transcribe.rs` for why not live),
 * and they arrive in exactly the shape synced lyrics already use - which is the
 * whole reason this is a small file. The surfaces that draw words over the
 * disc and in the lyrics panel do not learn anything new; they are handed a
 * `LyricLine[]` and cannot tell whether a singer or a narrator is behind it.
 *
 * Asked for ONE BOOK at the moment somebody opens it, never as part of a
 * library payload: a twelve-hour reading is tens of thousands of lines, and
 * the library listing is the request every device makes constantly.
 */

/** One in-flight or settled lookup per book. A miss caches too - a book with no
 *  transcript should not be asked for again every time the screen redraws. */
const cache = new Map<number, Promise<BookLine[] | null>>();

interface TranscriptLine {
  startMs: number;
  text: string;
  /** Word-level clocks, as the server stores them: `[startMs, word]` pairs.
   *  Absent on transcripts made before word tracking. */
  words?: [number, string][];
}

/** A line with each word's own clock, where the recogniser provided one.
 *  Shape-compatible with LyricLine, so every existing consumer reads it
 *  unchanged and only the reading face looks closer. */
export interface BookLine {
  time: number;
  text: string;
  words?: { t: number; w: string }[];
}

/**
 * The transcript for a track, or null when there is none - which is the answer
 * for every song, for a book nobody has transcribed, and for a device with no
 * server to ask.
 */
export function fetchTranscript(track: Track): Promise<BookLine[] | null> {
  if (track.kind !== 'book') return Promise.resolve(null);
  const id = trackIdFromPath(track.path);
  if (id == null) return Promise.resolve(null);
  const held = cache.get(id);
  if (held) return held;

  /*
   * The session that owns the PATH, not whichever server happens to be primary.
   *
   * A book lives on one hub, and with more than one signed in the primary is
   * often not it - asking the wrong server for track 1 gets either a refusal or,
   * worse, somebody else's track 1. `originFromPath` is how the rest of the app
   * answers this for per-track work, so it answers it here too.
   */
  const session = sessionForOrigin(originFromPath(track.path));
  if (!session) return Promise.resolve(null);

  const looked = request<{ lines: TranscriptLine[] }>(session.url, `/api/transcribe/${id}`, {
    token: session.token,
  })
    .then((r) =>
      // Seconds, because that is what the kit's line takes and what every
      // caller compares against the playhead.
      (r.lines ?? [])
        .filter((l) => typeof l.text === 'string' && l.text.trim().length > 0)
        .map((l) => ({
          time: l.startMs / 1000,
          text: l.text.trim(),
          ...(Array.isArray(l.words) && l.words.length > 0
            ? {
                words: l.words
                  .filter((p) => Array.isArray(p) && typeof p[0] === 'number')
                  .map(([t, w]) => ({ t: t / 1000, w: String(w) })),
              }
            : {}),
        })),
    )
    /*
     * BOUNDED, whatever the server sent.
     *
     * A recogniser's segments run three to eight seconds, so a long book is
     * tens of thousands of lines - and every surface downstream was built for
     * a song's sixty. The windowing added to those surfaces helps the ones we
     * know about; this is the guarantee for the ones we do not: adjacent
     * lines merge until the sheet fits under four thousand, which for an
     * eighteen-hour book still means a line every fifteen seconds or so -
     * finer than anyone taps. Songs never come through here at all.
     */
    .then((lines) => {
      const CAP = 4000;
      if (lines.length <= CAP) return lines;
      const stride = Math.ceil(lines.length / CAP);
      const merged: BookLine[] = [];
      for (let i = 0; i < lines.length; i += stride) {
        const span = lines.slice(i, i + stride);
        const words = span.flatMap((l) => l.words ?? []);
        merged.push({
          time: span[0]!.time,
          text: span.map((l) => l.text).join(' '),
          ...(words.length > 0 ? { words } : {}),
        });
      }
      return merged;
    })
    .then((lines) => (lines.length > 0 ? lines : null))
    .catch(() => null);

  cache.set(id, looked);
  return looked;
}

/** Forget what we know about one book, so a transcript that has just been made
 *  is picked up without a reload. */
export function forgetTranscript(track: Track): void {
  const id = trackIdFromPath(track.path);
  if (id != null) cache.delete(id);
}
