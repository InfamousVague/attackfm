import { useEffect, useSyncExternalStore } from 'react';
import type { ServerSession } from '../server.ts';
import { request } from '../api/http.ts';
import { trackIdFromPath } from '../api/library.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Volume levelling: a library where a 1979 vinyl rip and a 2019 remaster
 * arrive at the ear at the same level.
 *
 * The server measures each track once (server/src/loudness.rs, EBU R128 via
 * ffmpeg) and publishes a table of `[trackId, lufs, peakDb, lra]`. This holds
 * that table and answers one question: how many dB should this track be
 * shifted by. The Player hands the answer to the meter's own gain stage, so
 * nothing is re-encoded and the raw-file path is untouched - which is the
 * whole reason this is a client decision rather than a server filter.
 *
 * Two modes, both of which real listeners want for different reasons:
 *
 *   track  every song at the same level. Right for shuffle, wrong for an
 *          album - it flattens the quiet track the artist meant to be quiet.
 *   album  every ALBUM at the same level, preserving the relative levels
 *          within it. Right for listening to a record end to end.
 *
 * The clipping rule is not optional. Lifting a track that already peaks at
 * -0.2 dBFS by +6 dB does not make it louder, it makes it broken - so a boost
 * is capped by the track's own measured headroom and the shortfall is simply
 * accepted. This is what ReplayGain has always called peak protection, and
 * skipping it is how naive implementations earn their reputation.
 */

/** Where the level sits when normalisation is on. -14 LUFS is what streaming
 *  has trained everyone's ears on; the ReplayGain era used -18. */
const DEFAULT_TARGET = -14;
/** The ceiling a normalised track may reach. -1 dBTP leaves room for the
 *  reconstruction overshoot a true-peak reading is measuring in the first
 *  place. */
const CEILING = -1;
/** Beyond this the cure is worse than the disease: a +15 dB lift on a very
 *  quiet transfer brings its noise floor up with it. */
const MAX_BOOST = 12;
const MAX_CUT = -24;

export type LoudnessMode = 'off' | 'track' | 'album';

interface Reading {
  lufs: number;
  peak: number;
  lra: number;
}

interface Table {
  target: number;
  byId: Map<number, Reading>;
  /** Album key -> the album's own integrated level, derived once. */
  albums: Map<string, number>;
}

const EMPTY: Table = { target: DEFAULT_TARGET, byId: new Map(), albums: new Map() };
const MODE_KEY = 'attackfm-loudness-mode';

let table: Table = EMPTY;
let mode: LoudnessMode = readMode();
const listeners = new Set<() => void>();

function readMode(): LoudnessMode {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return raw === 'off' || raw === 'track' || raw === 'album' ? raw : 'album';
  } catch {
    return 'album';
  }
}

function announce(): void {
  for (const fn of listeners) fn();
}

export function loudnessMode(): LoudnessMode {
  return mode;
}

export function setLoudnessMode(next: LoudnessMode): void {
  mode = next;
  try {
    localStorage.setItem(MODE_KEY, next);
  } catch {
    // A storage that will not take the setting is not worth failing over.
  }
  announce();
}

export function useLoudnessMode(): LoudnessMode {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    loudnessMode,
    loudnessMode,
  );
}

/** How many tracks carry a reading - what the settings pane reports as
 *  progress while the server works through the library. */
export function loudnessCoverage(): number {
  return table.byId.size;
}

/**
 * An album's level, from its tracks.
 *
 * Averaged in the ENERGY domain rather than the dB domain, because LUFS is
 * logarithmic and a plain mean of dB values is not a level - it flatters
 * whichever track is quietest. Weighted by nothing else: R128 album loudness
 * is properly the integrated loudness of the whole record played end to end,
 * and the energy mean is the standard approximation of it from track values.
 */
function albumLevel(readings: Reading[]): number {
  if (readings.length === 0) return DEFAULT_TARGET;
  const meanEnergy =
    readings.reduce((sum, r) => sum + 10 ** (r.lufs / 10), 0) / readings.length;
  return 10 * Math.log10(meanEnergy);
}

/** The album a track belongs to, for grouping. Album artist as well as title,
 *  so two records called "Greatest Hits" are two records. */
function albumKey(t: Track): string {
  return `${(t.albumArtist || t.artist || '').toLowerCase()}${(t.album || '').toLowerCase()}`;
}

/**
 * The gain for this track, in dB. 0 when normalisation is off, when the track
 * has no reading yet, or when nothing needs to move.
 */
export function gainFor(track: Track | null, library: readonly Track[]): number {
  if (!track || mode === 'off') return 0;
  const id = trackIdFromPath(track.path);
  if (id === null) return 0;
  const reading = table.byId.get(id);
  if (!reading) return 0;

  let level = reading.lufs;
  if (mode === 'album') {
    const key = albumKey(track);
    let cached = table.albums.get(key);
    if (cached === undefined) {
      const siblings: Reading[] = [];
      for (const t of library) {
        if (albumKey(t) !== key) continue;
        const sid = trackIdFromPath(t.path);
        const r = sid === null ? undefined : table.byId.get(sid);
        if (r) siblings.push(r);
      }
      cached = albumLevel(siblings.length > 0 ? siblings : [reading]);
      table.albums.set(key, cached);
    }
    level = cached;
  }

  const wanted = table.target - level;
  // Peak protection: never lift a track past the ceiling its own true peak
  // allows. In album mode the track's OWN peak still governs - the loudest
  // track on the record is the one that would clip.
  const headroom = CEILING - reading.peak;
  const capped = Math.min(wanted, Math.max(0, headroom));
  return Math.max(MAX_CUT, Math.min(MAX_BOOST, capped));
}

/**
 * Keeps the table loaded for the signed-in server.
 *
 * Fetched once per session rather than polled: the numbers only change as the
 * analyser works through the library, and a table that is a few minutes stale
 * costs a listener nothing - the affected track simply plays unlevelled, as
 * it did before any of this existed.
 */
export function useLoudnessTable(session: ServerSession | null): void {
  useEffect(() => {
    if (!session) {
      table = EMPTY;
      return;
    }
    let live = true;
    void (async () => {
      try {
        const body = await request<{ target?: number; tracks?: [number, number, number, number][] }>(
          session.url,
          '/api/loudness',
          { token: session.token },
        );
        if (!live) return;
        const byId = new Map<number, Reading>();
        for (const row of body.tracks ?? []) {
          if (!Array.isArray(row) || row.length < 3) continue;
          const [id, lufs, peak, lra] = row;
          if (typeof id !== 'number' || typeof lufs !== 'number') continue;
          byId.set(id, {
            lufs,
            peak: typeof peak === 'number' ? peak : 0,
            lra: typeof lra === 'number' ? lra : 0,
          });
        }
        table = {
          target: typeof body.target === 'number' ? body.target : DEFAULT_TARGET,
          byId,
          albums: new Map(),
        };
        announce();
      } catch {
        // An older server has no such route, and a library with no readings
        // yet is the same case: nothing is levelled, nothing is broken.
        table = EMPTY;
      }
    })();
    return () => {
      live = false;
    };
  }, [session]);
}
