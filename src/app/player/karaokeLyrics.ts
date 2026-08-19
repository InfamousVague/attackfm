/**
 * LRC lyrics, parsed for singing along to.
 *
 * The app stores lyrics as they came off the file, which for most of this
 * library means LRC: one line per line, each stamped `[mm:ss.xx]`. That stamp
 * is the whole difference between words on a screen and karaoke, so this pulls
 * it out and hands back lines in time order.
 *
 * Parsed here rather than imported because the app's own lyrics module is not
 * on the plugin host's allow-list - and this is fifteen lines, which is less
 * than the argument for widening that list would be.
 */

export interface Line {
  /** Seconds from the start of the track. */
  at: number;
  text: string;
}

export interface Lyrics {
  /** Timed lines, in order. Empty when the song carries none. */
  lines: Line[];
  /** True when the source had timestamps - the difference between following
   *  the song and merely displaying it. */
  timed: boolean;
}

/** `[mm:ss.xx]` or `[mm:ss]`, at the head of a line. Some files carry several
 *  stamps on one line for a repeated chorus; each becomes its own entry. */
const STAMP = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;

export function parseLyrics(raw: string): Lyrics {
  if (!raw || !raw.trim()) return { lines: [], timed: false };
  const lines: Line[] = [];
  let timed = false;

  for (const source of raw.split(/\r?\n/)) {
    STAMP.lastIndex = 0;
    const stamps: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = STAMP.exec(source)) !== null) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      // Two digits is hundredths, three is milliseconds - both appear.
      const fraction = match[3] ? Number(match[3]) / (match[3].length === 3 ? 1000 : 100) : 0;
      if (Number.isFinite(minutes) && Number.isFinite(seconds)) {
        stamps.push(minutes * 60 + seconds + fraction);
      }
    }
    const text = source.replace(STAMP, '').trim();
    if (stamps.length > 0) {
      timed = true;
      // A blank line with a stamp is a real thing in LRC: it marks a gap, and
      // keeping it is what lets the screen fall quiet between verses.
      for (const at of stamps) lines.push({ at, text });
    } else if (text) {
      // Untimed lines still show, just without following along.
      lines.push({ at: Number.NaN, text });
    }
  }

  if (timed) {
    // Only the timed ones can be ordered; untimed strays are dropped rather
    // than piled at the start where they would look like a first verse.
    const inTime = lines.filter((l) => Number.isFinite(l.at));
    inTime.sort((a, b) => a.at - b.at);
    return { lines: inTime, timed: true };
  }
  return { lines, timed: false };
}

/**
 * Which line is being sung at `seconds`.
 *
 * The last line whose stamp has passed - not the nearest, which would light
 * the next line up early and have the singer come in ahead of the music.
 * Returns -1 before the first line.
 */
export function lineAt(lines: readonly Line[], seconds: number): number {
  let found = -1;
  // Linear from the top is fine: a song has a few hundred lines and this runs
  // a few times a second. A binary search here would be cleverness nobody
  // asked for.
  for (let i = 0; i < lines.length; i += 1) {
    if ((lines[i]?.at ?? Infinity) <= seconds) found = i;
    else break;
  }
  return found;
}
