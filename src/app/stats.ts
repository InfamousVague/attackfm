/**
 * The client half of the listening stats.
 *
 * One endpoint, one shape: the server folds the whole listen log into a
 * summary per range, bucketed in the LISTENER'S hours rather than UTC ones -
 * which is why every request carries `tzMin`. A 11pm listen is a late-night
 * listen wherever the box happens to live.
 *
 * Everything that comes back passes through `normalizeStatsSummary` before
 * anyone renders it. The page draws bars and ranks rows straight off these
 * fields, and a chart that divides by a missing maximum or maps a missing
 * array is a blank page - so an older server, a partial reply, or a field the
 * server has not learned yet all normalise to zeros and empty lists, and the
 * page degrades to "nothing counted yet" instead of crashing.
 */

import type { ServerSession } from './server.ts';

/** How far back the summary reaches. The server derives `since` from it. */
export type StatsRange = 'week' | 'month' | 'year' | 'all';

export interface StatsArtist {
  artist: string;
  plays: number;
  minutes: number;
  /** A track of theirs whose artwork can stand in for a portrait, or null. */
  coverTrackId: number | null;
}

export interface StatsTrack {
  trackId: number;
  title: string;
  artist: string;
  plays: number;
  minutes: number;
}

export interface StatsAlbum {
  album: string;
  artist: string;
  plays: number;
  minutes: number;
}

export interface StatsGenre {
  genre: string;
  minutes: number;
}

export interface StatsDay {
  /** A local calendar day, `YYYY-MM-DD`. */
  day: string;
  minutes: number;
}

/** The average character of what got played, when the server has analysed it. */
export interface StatsSound {
  bpm: number;
  /** 0..1 */
  energy: number;
  /** 0..1 */
  brightness: number;
}

export interface StatsSummary {
  range: StatsRange;
  /** Where the window opens, as the server states it. */
  since: string;
  minutes: number;
  plays: number;
  uniqueTracks: number;
  uniqueArtists: number;
  topArtists: StatsArtist[];
  topTracks: StatsTrack[];
  topAlbums: StatsAlbum[];
  topGenres: StatsGenre[];
  /** Minutes per local hour of day - always exactly 24 entries. */
  clock: number[];
  /** One entry per local day, oldest first. */
  byDay: StatsDay[];
  streakDays: number;
  /** 0..1 - the share of plays bailed on inside thirty seconds. */
  skipRate: number;
  /** 0..1 */
  completionRate: number;
  /** Songs in the window that had never been played before it. */
  firstListens: number;
  sound: StatsSound | null;
}

/* ------------------------------------------------------------- normalising */

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function rec(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Coerces whatever the server sent into a `StatsSummary` the page can render
 * without a single guard at the point of use: every array is an array, every
 * number a finite number, and the clock is exactly 24 buckets however many
 * arrived. The requested range stands in when the reply does not name one.
 */
export function normalizeStatsSummary(raw: unknown, range: StatsRange): StatsSummary {
  const r = rec(raw);
  const clockRaw = arr(r.clock);
  const soundRaw = r.sound === null || r.sound === undefined ? null : rec(r.sound);
  const replyRange = str(r.range);
  return {
    range:
      replyRange === 'week' || replyRange === 'month' || replyRange === 'year' || replyRange === 'all'
        ? replyRange
        : range,
    since: str(r.since),
    minutes: num(r.minutes),
    plays: num(r.plays),
    uniqueTracks: num(r.uniqueTracks),
    uniqueArtists: num(r.uniqueArtists),
    topArtists: arr(r.topArtists).map((row) => {
      const a = rec(row);
      return {
        artist: str(a.artist),
        plays: num(a.plays),
        minutes: num(a.minutes),
        coverTrackId:
          typeof a.coverTrackId === 'number' && Number.isFinite(a.coverTrackId)
            ? a.coverTrackId
            : null,
      };
    }),
    topTracks: arr(r.topTracks).map((row) => {
      const t = rec(row);
      return {
        trackId: num(t.trackId),
        title: str(t.title),
        artist: str(t.artist),
        plays: num(t.plays),
        minutes: num(t.minutes),
      };
    }),
    topAlbums: arr(r.topAlbums).map((row) => {
      const a = rec(row);
      return { album: str(a.album), artist: str(a.artist), plays: num(a.plays), minutes: num(a.minutes) };
    }),
    topGenres: arr(r.topGenres).map((row) => {
      const g = rec(row);
      return { genre: str(g.genre), minutes: num(g.minutes) };
    }),
    clock: Array.from({ length: 24 }, (_, hour) => num(clockRaw[hour])),
    byDay: arr(r.byDay)
      .map((row) => {
        const d = rec(row);
        return { day: str(d.day), minutes: num(d.minutes) };
      })
      .filter((d) => d.day !== ''),
    streakDays: num(r.streakDays),
    skipRate: clamp01(num(r.skipRate)),
    completionRate: clamp01(num(r.completionRate)),
    firstListens: num(r.firstListens),
    sound: soundRaw
      ? {
          bpm: num(soundRaw.bpm),
          energy: clamp01(num(soundRaw.energy)),
          brightness: clamp01(num(soundRaw.brightness)),
        }
      : null,
  };
}

/* -------------------------------------------------------------- formatting */

/**
 * Minutes as a headline: plain minutes while the number reads at a glance,
 * hours once it stops ("1,284 min" is a calculation, "21.4 hr" is a fact).
 * Big hour counts drop the decimal - at 300 hours the .4 is noise.
 */
export function fmtMinutes(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole <= 120) return `${whole.toLocaleString()} min`;
  const hours = whole / 60;
  const shown = hours >= 100 ? Math.round(hours) : Math.round(hours * 10) / 10;
  return `${shown.toLocaleString()} hr`;
}

/** A 0..1 rate as the percentage people actually say. */
export function fmtPercent(rate: number): string {
  return `${Math.round(clamp01(rate) * 100)}%`;
}

/* ------------------------------------------------------------------- fetch */

/**
 * The summary for one range. `tzMin` is `getTimezoneOffset()` AS IS: the
 * minutes to SUBTRACT from UTC to reach the listener's wall clock, which is
 * the convention the server documents and applies (local = utc - tzMin). This
 * used to send the negation, which shifted the clock, the day bars and the
 * streak by twice the zone offset - ten hours for an EST listener.
 * returns, because JavaScript's convention points the other way.
 */
export async function fetchStatsSummary(
  session: ServerSession,
  range: StatsRange,
  signal?: AbortSignal,
): Promise<StatsSummary> {
  const tzMin = new Date().getTimezoneOffset();
  const res = await fetch(`${session.url}/api/stats/summary?range=${range}&tzMin=${tzMin}`, {
    headers: { authorization: `Bearer ${session.token}` },
    signal,
  });
  if (!res.ok) throw new Error(`stats: ${res.status} ${res.statusText}`);
  return normalizeStatsSummary((await res.json()) as unknown, range);
}
