import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { LoudnessMeter } from '@glacier/react';
import type { Track } from '../core/tauri.ts';

/**
 * The one loudness reading in the app, published where anything can watch it.
 *
 * The analyser hangs off the audio element, which the player owns, but the
 * header sits above the player in the tree and needs the same signal to move
 * to. Rather than lift the whole audio graph up - the player is the only thing
 * that should be touching it - the player publishes the reader here and
 * whatever wants to animate reads it.
 */
interface MotionSource {
  /** Reads current loudness, 0..1. Null until the first play builds the graph. */
  meter: LoudnessMeter | null;
  /**
   * Whether anything is actually coming out. Paused, muted, or a fader on the
   * floor all read false: the meter still reads the source in those states, and
   * a header pulsing to a track nobody can hear would be a lie.
   */
  audible: boolean;
  /** What is on the deck - the demo stream counts - so watchers can look
   * things up about it (the hero's lyric words do). Null before anything is. */
  track: Track | null;
  /** Playback position in seconds, at the element's own ~4Hz cadence. Coarse
   * on purpose: it is for things that change by the line, not by the frame. */
  position: number;
}

interface NowPlayingMotionValue extends MotionSource {
  publish: (source: MotionSource) => void;
}

const NowPlayingMotionContext = createContext<NowPlayingMotionValue | null>(null);

export function NowPlayingMotionProvider({ children }: { children: ReactNode }) {
  const [source, setSource] = useState<MotionSource>({
    meter: null,
    audible: false,
    track: null,
    position: 0,
  });

  // Held to the same object unless something actually moved: the player pushes
  // on every render that touches playback, and a fresh object each time would
  // restart the animation loop below it for nothing.
  const publish = useCallback((next: MotionSource) => {
    setSource((prev) =>
      prev.meter === next.meter &&
      prev.audible === next.audible &&
      prev.track === next.track &&
      prev.position === next.position
        ? prev
        : next,
    );
  }, []);

  const value = useMemo<NowPlayingMotionValue>(
    () => ({
      meter: source.meter,
      audible: source.audible,
      track: source.track,
      position: source.position,
      publish,
    }),
    [source, publish],
  );

  return (
    <NowPlayingMotionContext.Provider value={value}>{children}</NowPlayingMotionContext.Provider>
  );
}

export function useNowPlayingMotion(): NowPlayingMotionValue {
  const value = useContext(NowPlayingMotionContext);
  if (!value) throw new Error('useNowPlayingMotion must be used within a NowPlayingMotionProvider');
  return value;
}
