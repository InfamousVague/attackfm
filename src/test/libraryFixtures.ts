/**
 * Track fixtures for the library / playlists / albumArtist / search suites.
 *
 * Lives under `src/test/` rather than beside a module because five suites
 * share it, and because everything under here is out of the coverage
 * denominator - a fixture file counted as covered source flatters the number
 * without a single assertion behind it.
 *
 * `track()` fills every REQUIRED field of `Track` with something harmless and
 * lets a test name only the fields its rule is about. That is the whole point:
 * a test for the running-order comparator should read as "disc 2 track 1 comes
 * after disc 1 track 9" and not carry eleven fields of noise that say nothing.
 * It is typed as `Track` rather than `any` on purpose - when the shape moves,
 * the fixture stops compiling, which is the compiler telling the suite that
 * what it is pretending to be no longer exists.
 */
import type { Track } from '../app/core/tauri.ts';

let seq = 0;

/** A track with sensible defaults; `over` names only what the test cares about. */
export function track(over: Partial<Track> = {}): Track {
  seq += 1;
  return {
    path: `/music/track-${seq}.mp3`,
    title: `Track ${seq}`,
    artist: 'Some Artist',
    album: 'Some Album',
    duration: 180,
    addedAt: 1_700_000_000_000 + seq,
    artwork: null,
    genre: '',
    lyrics: '',
    ...over,
  };
}

/** A remote track path, the `afm://<id>` shape `trackIdFromPath` reads. */
export function remoteTrack(id: number, over: Partial<Track> = {}): Track {
  return track({ path: `afm://${id}`, ...over });
}
