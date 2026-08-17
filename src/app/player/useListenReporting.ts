import { useEffect, useRef, type MutableRefObject } from 'react';
import {
  fetchPlayStates,
  reportPlay,
  reportPosition,
  trackIdFromPath,
  type ServerSession,
} from '../server.ts';
import { createListenReporter, type ListenSnapshot } from './listens.ts';
import { usePlayback } from './playback.tsx';
import type { Track } from '../core/tauri.ts';

type Playback = ReturnType<typeof usePlayback>;

/**
 * The listening log. One report per listen-through, once the track has
 * genuinely been HEARD - thirty seconds of actual playback, or half its
 * length for anything shorter, the shape of threshold streaming services
 * count by. Measured as accumulated listened time, not a position reached:
 * a scrub or a jump forward to 0:45 moves the clock without playing those
 * seconds, and must not count as a listen. A new track resets the tally;
 * repeat-one restarts it, so every spin is logged. Server only - local
 * listening has no account to write history against.
 *
 * Extracted from Player.tsx; the shared refs (scrubbing, playbackRef,
 * positionRef, playSessionRef) are the Player's own objects, passed in so
 * this reads exactly what the deck writes.
 */
export function useListenReporting({
  track,
  playing,
  audible,
  duration,
  coarsePosition,
  playSession,
  playSessionRef,
  scrubbing,
  playbackRef,
  positionRef,
  commitSeek,
}: {
  track: Track | null;
  playing: boolean;
  audible: boolean;
  duration: number;
  coarsePosition: number;
  playSession: ServerSession | null;
  playSessionRef: MutableRefObject<ServerSession | null>;
  scrubbing: MutableRefObject<boolean>;
  playbackRef: MutableRefObject<Playback>;
  positionRef: MutableRefObject<number>;
  commitSeek: (to: number) => void;
}): void {
  // The EVENT log rides beside the play counter below: the counter keeps the
  // legacy shelves (artist top songs) fed, while events - with their length,
  // completion and skip verdicts - feed the stats page and the curator's
  // self-tuning. Same honesty rules, same privacy switch. The reporter samples
  // this snapshot once a second and owns all the bookkeeping.
  const listenSnapRef = useRef<ListenSnapshot>({
    track: null,
    audible: false,
    duration: 0,
    session: null,
    record: false,
  });
  listenSnapRef.current = {
    track,
    audible: audible && !scrubbing.current,
    duration,
    session: playSession,
    record: playbackRef.current.saveHistory,
  };
  useEffect(() => {
    const reporter = createListenReporter(() => listenSnapRef.current);
    return reporter.dispose;
  }, []);

  const listened = useRef({ path: '' as string, seconds: 0, prev: 0, reported: false });
  useEffect(() => {
    if (!track) return;
    const l = listened.current;
    if (l.path !== track.path) {
      listened.current = { path: track.path, seconds: 0, prev: coarsePosition, reported: false };
      return;
    }
    const delta = coarsePosition - l.prev;
    l.prev = coarsePosition;
    // Only forward, only a natural tick's worth (<=2s), only while genuinely
    // playing and not scrubbing - anything larger is a seek and buys no
    // credit. A backward jump (rewind) re-arms the report for the next spin.
    // The rearm also restarts the tally: without the reset, seconds already
    // past the threshold would log a duplicate play the instant a rewind
    // lands, rather than after another genuine listen-through.
    if (delta < 0) {
      l.reported = false;
      l.seconds = 0;
    }
    if (playing && !scrubbing.current && delta > 0 && delta <= 2) {
      l.seconds += delta;
    }
    if (l.reported) return;
    const threshold = Math.min(30, Math.max(5, (duration || 60) / 2));
    if (l.seconds < threshold) return;
    l.reported = true;
    // The privacy switch: with history off the listen is simply never written.
    // Marked reported all the same, so flipping the switch mid-song does not
    // retroactively log a listen that began under "off".
    if (!playbackRef.current.saveHistory) return;
    const id = trackIdFromPath(track.path);
    if (id !== null && playSessionRef.current) reportPlay(playSessionRef.current, id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the clock drives it; the rest ride refs or are stable per tick
  }, [coarsePosition, playing, track, duration]);

  // ── The audiobook bookmark ───────────────────────────────────────────────
  //
  // A book is a place you return to, so the server learns where the listener
  // got to: every twenty seconds while a book section plays, and once more the
  // moment it pauses or the track changes. Music never reports - resuming a
  // song mid-verse is nobody's habit, and the chatter would buy nothing. The
  // position rides a ref so the interval never re-arms on every tick.
  useEffect(() => {
    if (!track || track.kind !== 'book') return;
    const id = trackIdFromPath(track.path);
    if (id === null) return;
    const send = () => {
      const s = playSessionRef.current;
      if (s) void reportPosition(s, id, positionRef.current * 1000).catch(() => {});
    };
    let timer: number | undefined;
    if (playing) {
      timer = window.setInterval(send, 20_000);
    }
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      // The parting word: pause, track change, or the sheet closing all land
      // the latest position before the interval dies.
      send();
    };
  }, [track, playing]);

  // The other half of the bookmark: a book section OPENS where the listener
  // left it. Runs once per track, only after the deck has learned a real
  // duration (seeking before the source is ready gets clobbered by the load),
  // and only for a spot worth returning to - past the first few seconds,
  // short of the end. commitSeek is the same door the scrubber uses, so every
  // clock, crossfade guard and republish rides along.
  const resumedPath = useRef<string | null>(null);
  useEffect(() => {
    if (!track || track.kind !== 'book' || !(duration > 0)) return;
    if (resumedPath.current === track.path) return;
    resumedPath.current = track.path;
    const id = trackIdFromPath(track.path);
    const s = playSessionRef.current;
    if (id === null || !s) return;
    let live = true;
    void fetchPlayStates(s)
      .then((states) => {
        if (!live) return;
        const mine = states.find((st) => st.trackId === id);
        if (!mine) return;
        const to = mine.positionMs / 1000;
        if (to > 15 && to < duration - 15) commitSeek(to);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commitSeek is rebuilt every render; the guard ref keeps this once-per-track
  }, [track, duration]);
}
