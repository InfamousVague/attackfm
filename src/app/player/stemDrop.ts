import { useSyncExternalStore } from 'react';

/**
 * Parts taken out of the song that is playing.
 *
 * This is a PLAYBACK setting, not an instrument. The first version of it was a
 * second deck: it seized the output, paused the real player, ran its own
 * transport, and put its own transport controls in a modal - so the seek bar you
 * were looking at belonged to a paused song while a different one played, and
 * you had to be inside the modal to hear anything you changed. Taking a part out
 * of a song is not a different kind of playback. It is the same song with
 * something missing, which is precisely what the encoder already does for every
 * other effect in the console.
 *
 * So it rides the stream URL beside `fx` and `fx2`, the player reloads in place
 * the way it does for any other change of sound, and everything else - the seek
 * bar, the position, the lock screen, the queue - carries on knowing nothing
 * about it.
 *
 * Runtime state, deliberately not persisted, and cleared whenever the track
 * changes. A part can only be muted on a song that has been separated, so a
 * setting that outlived the song would be silently inert on most of the library
 * and would surprise somebody days later on the one track it still applied to.
 */

export type StemDrop = { trackId: number | null; parts: string[] };

let state: StemDrop = { trackId: null, parts: [] };
const listeners = new Set<() => void>();

function commit(next: StemDrop): void {
  state = next;
  for (const l of listeners) l();
}

export function stemDrop(): StemDrop {
  return state;
}

/** The `drop` query parameter, or null when the song is whole. */
export function stemDropParam(trackId: number | null): string | null {
  if (state.trackId === null || state.trackId !== trackId || state.parts.length === 0) return null;
  return state.parts.join(',');
}

export function isStemDropped(part: string): boolean {
  return state.parts.includes(part);
}

/** Take a part out, or put it back. */
export function setStemDropped(trackId: number, part: string, dropped: boolean): void {
  const parts = state.trackId === trackId ? state.parts : [];
  const next = dropped ? [...new Set([...parts, part])] : parts.filter((p) => p !== part);
  commit({ trackId, parts: next });
}

/** Put everything back. */
export function clearStemDrop(): void {
  if (state.trackId === null && state.parts.length === 0) return;
  commit({ trackId: null, parts: [] });
}

/**
 * Forget the drops when the song changes.
 *
 * Called by the player on every track change. Guarded so it does not publish a
 * change - and therefore does not trigger a reload - when there was nothing to
 * forget, which is the overwhelmingly common case.
 */
export function stemDropFollowsTrack(trackId: number | null): void {
  if (state.trackId === null) return;
  if (state.trackId === trackId) return;
  commit({ trackId: null, parts: [] });
}

export function subscribeStemDrop(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useStemDrop(): StemDrop {
  return useSyncExternalStore(subscribeStemDrop, stemDrop, stemDrop);
}
