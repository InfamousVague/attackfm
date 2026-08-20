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
  /**
   * Per-part gain, 0 (fully out) to 1 (full). A part absent from the map plays
   * at full - which is what lets a part sit FAINT rather than only in or out:
   * `{ vocals: 0.2 }` is vocals at a whisper under everything else.
   */
  gains: Record<string, number>;
  /**
   * Bumped when we LEARN a song has parts, so a player holding a drop knows to
   * re-resolve its URL. The drop itself did not change - what changed is
   * whether it applies to the song already loaded - and nothing downstream
   * could see that without a signal.
   */
  revision: number;
}

let state: StemDrop = { gains: {}, revision: 0 };

/** True while any part is turned below full. */
function anyMoved(): boolean {
  return Object.values(state.gains).some((g) => g < 1);
}

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
  if (trackId === null || !anyMoved()) return null;
  if (applies.get(trackId) !== true) return null;
  // `name:gain` pairs for the parts turned below full - the server's `lvl`.
  return Object.entries(state.gains)
    .filter(([, g]) => g < 1)
    .map(([name, g]) => `${name}:${g.toFixed(2)}`)
    .join(',');
}

/** A part's current gain, 0..1 - full when it has never been touched. */
export function stemGain(part: string): number {
  return state.gains[part] ?? 1;
}

export function isStemDropped(part: string): boolean {
  return (state.gains[part] ?? 1) <= 0;
}

/** Set a part's level, 0 (out) to 1 (full). Applies to every song that has
 *  parts. Full removes it from the map, so "everything at full" is empty. */
export function setStemLevel(part: string, gain: number): void {
  const g = Math.max(0, Math.min(1, gain));
  const gains = { ...state.gains };
  if (g >= 1) delete gains[part];
  else gains[part] = g;
  commit({ ...state, gains });
}

/** Take a part fully out, or put it back to full. */
export function setStemDropped(part: string, dropped: boolean): void {
  setStemLevel(part, dropped ? 0 : 1);
}

/** Put everything back to full. */
export function clearStemDrop(): void {
  if (Object.keys(state.gains).length === 0) return;
  commit({ ...state, gains: {} });
}

/** Record what we know, for the resolver and for the next visit to this song. */
export function noteStemsFor(trackId: number, has: boolean): void {
  const before = applies.get(trackId);
  applies.set(trackId, has);
  // Only a YES changes anything anyone can hear, and only while a drop is set.
  // Publishing a "no" would reload a song to arrive at the URL it already has.
  if (has && before !== true && anyMoved()) {
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
  if (!anyMoved()) return;
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
