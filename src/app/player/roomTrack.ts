import { useEffect, useState } from 'react';
import type { Track } from '../core/tauri.ts';
import type { ServerSession } from '../api/http.ts';
import { fetchTrack, trackIdFromPath } from '../api/library.ts';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * The room's song, when this library does not list it.
 *
 * A groove names what it is playing by hub track id. Every surface that
 * draws the room - the follow seam that loads the song, PlayerHost's
 * following strip, the deck's hero, NOW and UP NEXT sleeves - used to look
 * that id up in THIS library's list and give up when it was absent: a disc
 * with a music note, the song by name, no sound. But the listing is scoped
 * per member (a collector pull the host adopted stays on the host's shelf),
 * while the hub streams any id to any member. So an id the library lacks is
 * asked of the hub instead - `GET /api/tracks/{id}`, the listing's own row
 * shape - and the answer is held here for the session:
 *
 *  - by `<hub>|<id>`, since a second hub's #42 is a different song;
 *  - one request per id, however many surfaces ask at once (an in-flight
 *    promise is shared) - the seam, the strip and the deck all resolve the
 *    same song off one fetch;
 *  - a 404 is remembered too, so a missing id is asked once and the "not in
 *    your library" note stands on a fact rather than a guess;
 *  - a failed request (no hub, a timeout) is not remembered as an answer;
 *    it holds the id back for a few seconds and lets it be asked again.
 *
 * The library is always consulted first. A room whose song this library
 * lists costs nothing here - no request, no state.
 */

/** The hub's word on an id: its row, or null for "no such track". */
export type RoomTrackAnswer = Track | null;

const answers = new Map<string, RoomTrackAnswer>();
const inFlight = new Map<string, Promise<RoomTrackAnswer>>();
const failedAt = new Map<string, number>();
/** How long a failed ask holds an id back before it may be asked again. */
const RETRY_MS = 10_000;

const keyOf = (session: ServerSession, id: number) => `${session.url}|${id}`;

/** What is already known, without asking: the row, null for a 404 the hub
 *  has given, undefined when the hub has not been asked (or answered) yet. */
export function peekRoomTrack(session: ServerSession, id: number): RoomTrackAnswer | undefined {
  return answers.get(keyOf(session, id));
}

/** The hub's row for an id, asked for at most once per session. Rejects on
 *  a transport failure (never on a 404, which resolves null). */
export function roomTrack(session: ServerSession, id: number): Promise<RoomTrackAnswer> {
  const key = keyOf(session, id);
  const known = answers.get(key);
  if (known !== undefined) return Promise.resolve(known);
  const going = inFlight.get(key);
  if (going) return going;
  const failed = failedAt.get(key);
  if (failed != null && Date.now() - failed < RETRY_MS) {
    return Promise.reject(new Error(`track #${id}: the last ask failed; waiting before asking again`));
  }
  const ask = fetchTrack(session, id).then(
    (track) => {
      answers.set(key, track);
      inFlight.delete(key);
      failedAt.delete(key);
      return track;
    },
    (err: unknown) => {
      inFlight.delete(key);
      failedAt.set(key, Date.now());
      throw err;
    },
  );
  inFlight.set(key, ask);
  return ask;
}

/** Test seam: forget every answer. */
export function forgetRoomTracks(): void {
  answers.clear();
  inFlight.clear();
  failedAt.clear();
}

// --- the library first ---------------------------------------------------

/** The library by hub id, built once per list (the list is a new array each
 *  sync, so keying on its identity is keying on its version). Shared by
 *  every hook instance rather than rebuilt per surface. */
const indexes = new WeakMap<Track[], Map<number, Track>>();
function indexOf(tracks: Track[]): Map<number, Track> {
  let index = indexes.get(tracks);
  if (!index) {
    index = new Map();
    for (const t of tracks) {
      const id = trackIdFromPath(t.path);
      if (id != null && !index.has(id)) index.set(id, t);
    }
    indexes.set(tracks, index);
  }
  return index;
}

/**
 * The Track behind a room's id: the library's own row first, the hub's
 * second. `undefined` while the hub is still being asked; `null` once it has
 * said there is no such track - the only state that earns a "not in your
 * library" note.
 */
export function useRoomTrack(id: number | null): RoomTrackAnswer | undefined {
  const { session } = useServerSession();
  const { allTracks } = useLibrary();
  const own = id != null ? indexOf(allTracks).get(id) : undefined;
  const fetched = session && id != null && !own ? peekRoomTrack(session, id) : undefined;
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!session || id == null || own || fetched !== undefined) return;
    let live = true;
    let retry = 0;
    roomTrack(session, id).then(
      () => {
        if (live) setTries((n) => n + 1);
      },
      () => {
        // Ask again once the hold has lapsed - a hub that was away for a
        // moment should not leave the room's song unnamed for the session.
        retry = window.setTimeout(() => {
          if (live) setTries((n) => n + 1);
        }, RETRY_MS);
      },
    );
    return () => {
      live = false;
      window.clearTimeout(retry);
    };
    // `tries` re-runs this after an answer (to read it) or a hold (to retry).
  }, [session, id, own, fetched, tries]);
  return own ?? fetched;
}

/**
 * The same, for a line-up: the room's queue ids to their Tracks. Own rows
 * and answered ids are in the map (a 404 as null); an id still being asked
 * is absent. One request per id the library lacks, shared with every other
 * surface asking about it.
 */
export function useRoomTracks(ids: readonly number[]): Map<number, RoomTrackAnswer> {
  const { session } = useServerSession();
  const { allTracks } = useLibrary();
  const index = indexOf(allTracks);
  const out = new Map<number, RoomTrackAnswer>();
  const pending: number[] = [];
  for (const id of ids) {
    const own = index.get(id);
    if (own) {
      out.set(id, own);
      continue;
    }
    const known = session ? peekRoomTrack(session, id) : undefined;
    if (known !== undefined) out.set(id, known);
    else pending.push(id);
  }
  const pendingKey = pending.join(',');
  const [tries, setTries] = useState(0);
  useEffect(() => {
    if (!session || !pendingKey) return;
    let live = true;
    let retry = 0;
    void Promise.allSettled(pendingKey.split(',').map((s) => roomTrack(session, Number(s)))).then((settled) => {
      if (!live) return;
      setTries((n) => n + 1);
      if (settled.some((r) => r.status === 'rejected')) {
        retry = window.setTimeout(() => {
          if (live) setTries((n) => n + 1);
        }, RETRY_MS);
      }
    });
    return () => {
      live = false;
      window.clearTimeout(retry);
    };
  }, [session, pendingKey, tries]);
  return out;
}
