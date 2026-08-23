import { useEffect, useState } from 'react';
import { Lyrics } from '@glacier/react';
import { fetchLyrics, type TrackLyrics } from './lyrics.ts';
import type { Track } from '../core/tauri.ts';

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
