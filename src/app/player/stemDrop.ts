import { useSyncExternalStore } from 'react';
import { stemStatus } from '../api/stems.ts';
import type { ServerSession } from '../api/http.ts';

/**
 * Parts taken out of what is playing.
 *
 * This is a PLAYBACK setting, not an instrument. It rides the stream URL beside
 * `fx` and `fx2`; the server hands the encoder the parts that are left, and the
 * player reloads where it stands the way it does for any other change of sound.
 * The transport never learns about it, so the seek bar cannot disagree with the
 * song.
 *
 * It used to be scoped to ONE track and forgotten on the next, on the reasoning
 * that a part can only be muted on a song that has been separated - so a drop
 * that outlived its song would be inert across most of a library. That was true
 * when separating was something you asked for a song at a time. It stopped
 * being true when the server started separating ahead: on a library that is
 * mostly separated, dropping the vocal is a way you want to LISTEN, and having
 * it snap back on every skip made it useless for the thing it is for.
 *
 * So the drop is a preference now, and the per-song question it used to answer
 * moved to where it belongs: a part is dropped from a song only if that song
 * actually has parts. `applies` is what remembers which do.
 *
 * Deliberately not persisted. Carrying it across songs is what was asked for;
 * carrying it across a relaunch would mean somebody opens the app a week later
 * to a vocal-less library and no memory of why.
 */

export interface StemDrop {
  parts: string[];
  /**
   * Bumped when we LEARN a song has parts, so a player holding a drop knows to
   * re-resolve its URL. The drop itself did not change - what changed is
   * whether it applies to the song already loaded - and nothing downstream
   * could see that without a signal.
   */
  revision: number;
}

let state: StemDrop = { parts: [], revision: 0 };

/**
 * Which tracks have parts, as far as we know.
 *
 * Absent means unasked, not absent-means-no: the difference decides whether the
 * next track change spends a request. Session-only, because it is a cache of
 * something the server owns and re-learning it costs one small call.
 */
const applies = new Map<number, boolean>();
const asking = new Set<number>();

const listeners = new Set<() => void>();

function commit(next: StemDrop): void {
  state = next;
  for (const l of listeners) l();
}

export function stemDrop(): StemDrop {
  return state;
}

/**
 * The `drop` query value for one track, or null.
 *
 * Null for a song with no parts even when a drop is set, and that is the whole
 * point of `applies`: `drop` forces the encoder, so sending it for a song the
 * server cannot honour would spend a transcode - and a listener's lossless
 * stream - to achieve exactly nothing.
 */
export function stemDropParam(trackId: number | null): string | null {
  if (trackId === null || state.parts.length === 0) return null;
  return applies.get(trackId) === true ? state.parts.join(',') : null;
}

export function isStemDropped(part: string): boolean {
  return state.parts.includes(part);
}

/** Take a part out, or put it back. Applies to every song that has parts. */
export function setStemDropped(part: string, dropped: boolean): void {
  const parts = dropped
    ? [...new Set([...state.parts, part])]
    : state.parts.filter((p) => p !== part);
  commit({ ...state, parts });
}

/** Put everything back. */
export function clearStemDrop(): void {
  if (state.parts.length === 0) return;
  commit({ ...state, parts: [] });
}

/** Record what we know, for the resolver and for the next visit to this song. */
export function noteStemsFor(trackId: number, has: boolean): void {
  const before = applies.get(trackId);
  applies.set(trackId, has);
  // Only a YES changes anything anyone can hear, and only while a drop is set.
  // Publishing a "no" would reload a song to arrive at the URL it already has.
  if (has && before !== true && state.parts.length > 0) {
    commit({ ...state, revision: state.revision + 1 });
  }
}

export function stemsKnownFor(trackId: number): boolean | undefined {
  return applies.get(trackId);
}

/**
 * On a new song: find out whether the drop applies to it.
 *
 * Costs one small request, and only while a drop is actually set - somebody who
 * has never touched the Stems tab never spends it. The answer is cached for the
 * session, so a queue that comes back round asks once.
 */
export function stemDropOnTrack(session: ServerSession | null, trackId: number | null): void {
  if (!session || trackId === null) return;
  if (state.parts.length === 0) return;
  if (applies.has(trackId) || asking.has(trackId)) return;
  asking.add(trackId);
  void stemStatus(session, trackId)
    .then((s) => noteStemsFor(trackId, s.stems.length > 0))
    .catch(() => {
      // Unreachable server, or a track this box does not know. Left UNRECORDED
      // rather than recorded as a no: a no is cached for the session, and a
      // network blip would then mute the feature for that song until relaunch.
    })
    .finally(() => asking.delete(trackId));
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
