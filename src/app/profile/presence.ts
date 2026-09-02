/**
 * What this device is hearing, for the friends who are allowed to know.
 *
 * The Player writes here on every song and every play/pause (through the
 * Connect seam, which already watches both); the listening-share bridge reads
 * it and posts a heartbeat to the registry. A module store rather than a
 * context because the two live in different trees and the bridge must not
 * re-render on every tick of the deck - it wants the value when it is about
 * to post, and a nudge when the song changes.
 */
export interface NowPlayingBeat {
  title: string;
  artist: string;
  album: string;
  playing: boolean;
}

let current: NowPlayingBeat | null = null;
const listeners = new Set<() => void>();

export function setNowPlayingBeat(next: NowPlayingBeat | null): void {
  const same =
    (current === null && next === null) ||
    (current !== null &&
      next !== null &&
      current.title === next.title &&
      current.artist === next.artist &&
      current.playing === next.playing);
  current = next;
  if (!same) for (const l of listeners) l();
}

export function readNowPlayingBeat(): NowPlayingBeat | null {
  return current;
}

export function onNowPlayingBeat(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
