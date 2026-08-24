import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Lyrics } from '@glacier/react';
import { fetchLyrics, type SyncedLine, type TrackLyrics } from './lyrics.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Lyrics with a clock on every word.
 *
 * The kit's Lyrics lights a LINE - `LyricLine` is `{time, text}` and there is
 * nowhere in its props to say more - so a sheet that knows when each word is
 * sung needs its own small renderer. It keeps the kit's manners: the reading
 * line stays centred, every line is a seek target, and a hand on the scroll
 * takes it back for a few seconds rather than fighting for it.
 *
 * Within the lit line, each word carries where it stands: sung, being sung,
 * or still to come. A word held across a long note simply stays lit for as
 * long as it is held, which is the whole point of the exercise.
 */
function WordLyrics({
  lines,
  position,
  onSeek,
}: {
  lines: SyncedLine[];
  position: number;
  onSeek: (time: number) => void;
}) {
  let at = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.time <= position) at = i;
    else break;
  }
  const box = useRef<HTMLDivElement | null>(null);
  const here = useRef<HTMLButtonElement | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const quiet = useRef<number | null>(null);
  const touched = () => {
    setBrowsing(true);
    if (quiet.current) window.clearTimeout(quiet.current);
    quiet.current = window.setTimeout(() => setBrowsing(false), 4000);
  };
  useEffect(
    () => () => {
      if (quiet.current) window.clearTimeout(quiet.current);
    },
    [],
  );
  useLayoutEffect(() => {
    if (browsing) return;
    const b = box.current;
    const h = here.current;
    if (!b || !h) return;
    b.scrollTo({
      top: h.offsetTop - b.clientHeight / 2 + h.offsetHeight / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  }, [at, browsing]);

  return (
    <div
      ref={box}
      className="wordLyrics"
      onPointerDown={touched}
      onWheel={touched}
      onTouchMove={touched}
    >
      {lines.map((line, i) => {
        const state = i < at ? 'past' : i === at ? 'now' : 'next';
        // Only the line being sung spends spans; the rest are plain text,
        // because a song is hundreds of words and none of the others move.
        const words = i === at ? line.words : undefined;
        let lit = -1;
        if (words) {
          for (let k = 0; k < words.length; k++) {
            if (words[k]!.t <= position) lit = k;
            else break;
          }
        }
        return (
          <button
            key={`${line.time}-${i}`}
            ref={i === at ? here : undefined}
            type="button"
            className="wordLyrics__line"
            data-state={state}
            onClick={() => onSeek(line.time)}
          >
            {words
              ? words.map((w, k) => (
                  <span
                    key={k}
                    className="wordLyrics__w"
                    data-said={k < lit || undefined}
                    data-lit={k === lit || undefined}
                  >
                    {w.w}{' '}
                  </span>
                ))
              : line.text}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The mic popover's inside: the track's lyrics, fetched when the panel first
 * opens (the popover mounts its panel per open, so the effect is the lazy
 * trigger) and cached across opens by the lyrics module. Synced lines light
 * with playback and seek on press; plain-only lyrics read as static text -
 * no position, so nothing lights, and no handler, so nothing pretends to be
 * a button; and the waits and the misses are the same surface, empty, saying
 * which of the two it is.
 */
export function LyricsPanel({
  track,
  position,
  onSeek,
}: {
  track: Track;
  position: number;
  onSeek: (time: number) => void;
}) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchLyrics(track).then((found) => {
      if (!cancelled) setLyrics(found);
    });
    return () => {
      cancelled = true;
    };
  }, [track]);

  if (lyrics === null) return <Lyrics lines={[]} emptyLabel="Searching for lyrics…" aria-label="Lyrics" />;
  if (lyrics.synced) {
    /*
     * A window of a huge sheet, not the whole of it. Song lyrics are a couple
     * of hundred lines and render whole, exactly as before. A book transcript
     * is tens of thousands, and handing them all to the kit is tens of
     * thousands of DOM nodes in a phone webview - the kind of allocation the
     * OS answers by shooting the renderer, which kills the app. Six hundred
     * lines is half an hour of narration either side of the playhead; seeking
     * beyond the window re-centres it.
     */
    const all = lyrics.synced;
    let lines = all;
    if (all.length > 1500) {
      let at = 0;
      for (let i = 0; i < all.length; i += 1) {
        if (all[i]!.time <= position) at = i;
        else break;
      }
      lines = all.slice(Math.max(0, at - 600), at + 600);
    }
    // Word clocks anywhere in the sheet earn the finer renderer; a sheet
    // without them stays on the kit's, which is what every song had before
    // and what an unaligned song still gets.
    if (lines.some((l) => (l as SyncedLine).words?.length)) {
      return <WordLyrics lines={lines as SyncedLine[]} position={position} onSeek={onSeek} />;
    }
    return (
      <Lyrics
        lines={lines}
        position={position}
        onLineSelect={(line) => onSeek(line.time)}
        aria-label="Lyrics"
      />
    );
  }
  if (lyrics.plain) {
    return (
      <Lyrics lines={lyrics.plain.map((text) => ({ time: 0, text }))} aria-label="Lyrics" />
    );
  }
  return <Lyrics lines={[]} aria-label="Lyrics" />;
}
