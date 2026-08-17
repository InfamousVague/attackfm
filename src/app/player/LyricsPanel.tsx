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
    return (
      <Lyrics
        lines={lyrics.synced}
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
