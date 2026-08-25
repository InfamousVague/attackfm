import { useEffect, useState } from 'react';
import { sessionForOrigin } from '../servers/sessions.ts';
import { request } from '../api/http.ts';
import { originFromPath, trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The shape of a track, before a note of it is played.
 *
 * The seek bar has always been able to draw a waveform - the kit takes a run
 * of 0-1 samples and paints them behind the playhead - and until now the app
 * fed it the LIVE meter. That draws the moment you are in, which is a lovely
 * thing to watch and no help at all in answering the question people actually
 * ask a scrubber: where in this does the quiet bit end, and how much outro am
 * I about to sit through.
 *
 * The hub has known the answer all along. Its loudness pass walks every file
 * at 100ms resolution and threw the curve away; now it keeps it, and this
 * fetches it.
 *
 * Same rules as `transcript.ts` and `chapterNotes.ts` next door: asked once
 * per track, never part of a library payload, and a MISS caches too - a track
 * the sweep has not reached yet must not be asked again on every render.
 */

/** Heights 0-1, one per column, left to right. */
export type Shape = number[];

/** A track whose shape is not stored caches as null; a track whose request
 *  failed does not, so a launch race is retried rather than remembered. */
const cache = new Map<number, { p: Promise<Shape | null>; at: number }>();

/** The sweep fills shapes in over hours, so a miss is worth re-asking - but
 *  not often. Long enough that a full library never storms the hub, short
 *  enough that a track measured while the app is open turns up in a sitting. */
const MISS_TTL_MS = 10 * 60_000;

export function fetchShape(track: Track | null): Promise<Shape | null> {
  if (!track) return Promise.resolve(null);
  const id = trackIdFromPath(track.path);
  // A local file has no hub to ask. The live meter still draws it.
  if (id == null) return Promise.resolve(null);

  const held = cache.get(id);
  if (held && Date.now() - held.at < MISS_TTL_MS) return held.p;

  const session = sessionForOrigin(originFromPath(track.path));
  if (!session) return Promise.resolve(null);

  const looked = request<{ columns: number[] | null }>(
    session.url,
    `/api/waveform/${id}`,
    { token: session.token },
  )
    .then((r) => {
      const columns = r.columns;
      if (!Array.isArray(columns) || columns.length === 0) return null;
      // Stored as bytes because a byte is all the precision a column of a
      // seek bar can show; the kit wants 0-1.
      return columns.map((c) => Math.max(0, Math.min(255, c)) / 255);
    })
    .catch(() => {
      // A hub from before this shipped answers 404, and a hub that was asked
      // mid-restart answers nothing. Neither is a fact about the track, so
      // neither is remembered.
      cache.delete(id);
      return null;
    });

  cache.set(id, { p: looked, at: Date.now() });
  return looked;
}

/**
 * The current track's shape, or null while it is unknown.
 *
 * Null is a real answer and the caller wants it: it means "draw the live
 * meter instead", which is what the strip did before any of this and what it
 * must keep doing for a local file, an unmeasured track, or an older hub.
 */
export function useTrackShape(track: Track | null): Shape | null {
  const [shape, setShape] = useState<Shape | null>(null);
  const path = track?.path ?? null;

  useEffect(() => {
    // Cleared on the way in, not on the way out: holding the last song's
    // shape under the new song's playhead is worse than holding nothing,
    // because it looks like an answer.
    setShape(null);
    if (!track) return;
    let live = true;
    void fetchShape(track).then((s) => {
      if (live) setShape(s);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the path is the identity; the object is rebuilt every render
  }, [path]);

  return shape;
}
