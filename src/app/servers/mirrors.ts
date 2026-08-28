//! Streaming mirrors: the other servers that hold the same songs.
//!
//! `servers.ts` remembers where this device has BEEN - addresses, no tokens,
//! one at a time. This is the other axis: servers that are live right now and
//! can serve bytes for a song the session server also has. A home hub on the
//! same Wi-Fi and a VPS on the other side of the country hold the same track;
//! which one should feed the player is a question about latency, and it has a
//! different answer depending on where the phone woke up.
//!
//! So each mirror carries credentials (a stream token is what a media element
//! actually needs), a smoothed round-trip time, and an index of what it holds.
//! `pickSource` puts those together into "fetch this song from here".
//!
//! The library, playlists, favourites and everything else still come from the
//! ONE session server. A mirror is a delivery route, never a second opinion
//! about what the library contains.

import { noteServerAnswered, noteServerSilent } from '../api/reachability.ts';
import type { RemoteTrack, ServerSession } from '../server.ts';
import { loadCachedIndex, syncLibrary } from '../server.ts';
import { fold } from '../core/fold.ts';
import { describeFailure, recordDiag } from '../diag/diagLog.ts';

const KEY = 'attackfm-mirrors';

export interface Mirror {
  url: string;
  /** Session token: renews the stream token, and reads the index. */
  token: string;
  /** What rides the stream URL. Seven-day life, like any other. */
  streamToken: string;
  username: string;
  isAdmin: boolean;
  name?: string;
  addedAt: number;
}

// --- matching a song across two servers ------------------------------------

/**
 * The client's half of the server's `discovery::fold` - the house fold
 * (core/fold.ts), re-exported under the name this module's callers know.
 * Two servers give the same song two different row ids, so the only durable
 * join is the tags, and this has to fold EXACTLY as the Rust does or the
 * availability map quietly misses. This module used to carry its own
 * hand-rolled character loop that reached the same answer; one shared
 * implementation is one fewer copy to drift.
 */
export { fold };

/** The join key: folded artist, folded title. Matches the server's. */
export function trackKey(artist: string, title: string): string {
  return `${fold(artist)}${fold(title)}`;
}

// --- the ledger ------------------------------------------------------------

function read(): Mirror[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as Mirror[]) : [];
    return Array.isArray(list) ? list.filter((m) => typeof m?.url === 'string' && !!m.streamToken) : [];
  } catch {
    return [];
  }
}

function write(list: Mirror[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // The routing still applies for this run; it just will not survive a
    // relaunch.
  }
  for (const l of listeners) l();
}

const listeners = new Set<() => void>();

export function subscribeMirrors(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function mirrorList(): Mirror[] {
  return read();
}

/** Add (or refresh) a mirror. Re-authorising the same address replaces its
 *  credentials rather than filing a second card. */
export function addMirror(entry: Omit<Mirror, 'addedAt'> & { addedAt?: number }): void {
  const url = entry.url.replace(/\/+$/, '');
  const list = read().filter((m) => m.url !== url);
  write([...list, { ...entry, url, addedAt: entry.addedAt ?? Date.now() }]);
}

export function removeMirror(url: string): void {
  const clean = url.replace(/\/+$/, '');
  write(read().filter((m) => m.url !== clean));
  health.delete(clean);
  holdings.delete(clean);
}

// --- reachability ----------------------------------------------------------

export interface Health {
  /** Smoothed round-trip, ms. Null until the first successful probe. */
  latencyMs: number | null;
  /** False after a probe that failed - unreachable from this network. */
  ok: boolean;
  checkedAt: number;
  /**
   * Whether that box downloads imports, or null when it did not say.
   *
   * NULL IS NOT FALSE and callers must keep them apart: servers older than
   * 0.1.25 do not carry the field, and reading their silence as "cannot
   * download" would move imports off a box that has been fetching them fine.
   */
  imports: boolean | null;
}

const health = new Map<string, Health>();

/** How much of a new sample to believe. Low, because the interesting signal is
 *  "this box is near" and one slow response should not move that. */
const EWMA_ALPHA = 0.3;

/**
 * Time one unauthenticated request to a server.
 *
 * `/api/server` is the cheapest honest answer a box gives - no auth, no DB
 * beyond a count - so it measures the path rather than the query. Cache-busted
 * because a 304 from some middlebox would time the middlebox.
 */
export async function probe(url: string, signal?: AbortSignal): Promise<number | null> {
  const started = performance.now();
  try {
    const res = await fetch(`${url}/api/server?probe=${Date.now()}`, {
      signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(String(res.status));
    // Read as JSON rather than discarding the bytes: the body still has to be
    // consumed for the timing to mean anything, and it carries whether this
    // box downloads - which decides where an import can be sent.
    const info = (await res.json().catch(() => null)) as { imports?: unknown } | null;
    const sample = performance.now() - started;
    const prior = health.get(url);
    const smoothed =
      prior?.latencyMs == null ? sample : prior.latencyMs * (1 - EWMA_ALPHA) + sample * EWMA_ALPHA;
    health.set(url, {
      latencyMs: smoothed,
      ok: true,
      checkedAt: Date.now(),
      imports: typeof info?.imports === 'boolean' ? info.imports : null,
    });
    return smoothed;
  } catch (err) {
    // Keep the last known latency: a box that just failed one probe from a
    // flaky network has not become permanently far away.
    const prior = health.get(url);
    health.set(url, {
      latencyMs: prior?.latencyMs ?? null,
      ok: false,
      checkedAt: Date.now(),
      // A failed probe says nothing about what the box can do; keep what it
      // last told us rather than downgrading it to "unknown".
      imports: prior?.imports ?? null,
    });
    // This catch used to swallow the reason, and the grey dot's "unreachable"
    // was everything the device could say afterwards. The reason is the only
    // part anyone can act on, so it goes in the log the listener can hand over.
    recordDiag('probe', describeFailure(err, `${url}/api/server`));
    return null;
  }
}

export function healthOf(url: string): Health | null {
  return health.get(url) ?? null;
}

/** Probe every candidate at once - the session server included, since the
 *  whole point is comparing it against the others. */
export async function probeAll(urls: string[], signal?: AbortSignal): Promise<void> {
  await Promise.all(urls.map((u) => probe(u, signal)));
}

// --- what each mirror holds ------------------------------------------------

/** url -> (track key -> that server's row id for it). */
const holdings = new Map<string, Map<string, number>>();

function indexTracks(tracks: RemoteTrack[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of tracks) map.set(trackKey(t.artist, t.title), t.id);
  return map;
}

/** Read a mirror's holdings from the cache alone - no network, safe to call
 *  during a render pass. */
export function loadHoldings(url: string): Map<string, number> {
  const cached = holdings.get(url);
  if (cached) return cached;
  const built = indexTracks(loadCachedIndex(url).tracks);
  holdings.set(url, built);
  return built;
}

/** The reverse direction, for the session server only: the resolver is handed
 *  a row id and has to find the song's cross-server name. Built lazily and
 *  rebuilt whenever the index it came from has moved on. */
const keysById = new Map<string, { rev: number; map: Map<number, string> }>();

export function keyForTrackId(url: string, trackId: number): string | null {
  const index = loadCachedIndex(url);
  let entry = keysById.get(url);
  if (!entry || entry.rev !== index.rev) {
    const map = new Map<number, string>();
    for (const t of index.tracks) map.set(t.id, trackKey(t.artist, t.title));
    entry = { rev: index.rev, map };
    keysById.set(url, entry);
  }
  return entry.map.get(trackId) ?? null;
}

/**
 * Bring a mirror's holdings up to date.
 *
 * This is the same delta sync the session server gets, against the same
 * per-URL cache, so a settled mirror costs one request and the second launch
 * costs nothing. A failure leaves whatever was cached in place: a mirror that
 * cannot be reached is not a mirror that lost its music.
 */
export async function refreshHoldings(mirror: Mirror, signal?: AbortSignal): Promise<number> {
  try {
    const { tracks } = await syncLibrary(mirror as ServerSession, { signal });
    const map = indexTracks(tracks);
    holdings.set(mirror.url, map);
    return map.size;
  } catch {
    return loadHoldings(mirror.url).size;
  }
}

/**
 * A cover from whichever OTHER server holds this song, for when the session
 * server's art will not come. The failing URL names its track (the inert
 * `track` param art URLs carry for exactly this moment); the holdings map
 * names that song on each mirror; any HEALTHY holder qualifies - this is a
 * fallback for a dark server, not a race for a fast one, so the first
 * reachable candidate wins. Answers null when nobody else holds it, which
 * is the caller's cue to fall through to the placeholder as before.
 */
export function artFallbackUrl(session: ServerSession, failedArtUrl: string): string | null {
  if (!failedArtUrl.startsWith(session.url)) return null;
  const trackId = Number(/[?&]track=(\d+)/.exec(failedArtUrl)?.[1]);
  if (!Number.isFinite(trackId)) return null;
  const size = /[?&]size=(\d+)/.exec(failedArtUrl)?.[1];
  const key = keyForTrackId(session.url, trackId);
  if (!key) return null;
  for (const mirror of read()) {
    const id = loadHoldings(mirror.url).get(key);
    if (id === undefined) continue;
    const h = health.get(mirror.url);
    if (h && h.ok === false) continue;
    const sized = size ? `&size=${size}` : '';
    return `${mirror.url}/api/art/track/${id}?t=${encodeURIComponent(mirror.streamToken)}${sized}`;
  }
  return null;
}

// --- routing ---------------------------------------------------------------

export interface Source {
  url: string;
  streamToken: string;
  trackId: number;
  /** True when this is the session server rather than a mirror. */
  primary: boolean;
}

/**
 * How much faster a mirror must be before playback moves to it.
 *
 * Stickiness is not a nicety here. The stream token rides the URL's query
 * string, so changing route changes every URL for that song - and the app
 * leans hard on URL-stable caching for art and range requests. A route that
 * flapped between two nearly-equal boxes would bust that cache continuously
 * for no gain, so a challenger has to be a quarter faster to take over.
 */
const SWITCH_MARGIN = 0.75;

/** The route each server-holding song is currently taking, so a re-decision
 *  can prefer where it already is. Keyed by track key. */
const stuck = new Map<string, string>();

/**
 * Where to fetch this song from.
 *
 * The session server is the default and the fallback: it is the one that
 * definitely has the row, and the one whose credentials are certainly live. A
 * mirror wins only when it holds the same song AND is meaningfully nearer.
 *
 * Returns null when nothing better than the session server was found, which is
 * the caller's cue to do exactly what it did before mirrors existed.
 */
export function pickSource(session: ServerSession, trackId: number): Source | null {
  const mirrors = read();
  if (mirrors.length === 0 || !routingPref()) return null;

  // A song the session server's own index cannot name has no cross-server
  // identity, so it can only come from where it was found.
  const key = keyForTrackId(session.url, trackId);
  if (!key) return null;

  const home = health.get(session.url);
  // An unprobed session server is treated as near rather than far: without a
  // measurement the incumbent keeps the song.
  let bestUrl = session.url;
  let bestLatency = home?.ok === false ? Number.POSITIVE_INFINITY : (home?.latencyMs ?? 0);
  let bestId = trackId;
  let bestToken = session.streamToken;
  let bestIsPrimary = true;

  // Whoever carried this song last gets a discount, so a challenger has to be
  // a clear quarter faster to take the route rather than a millisecond faster.
  const priorUrl = stuck.get(key);
  const score = (url: string, latency: number) => (url === priorUrl ? latency * SWITCH_MARGIN : latency);

  let bestScore = score(bestUrl, bestLatency);
  for (const mirror of mirrors) {
    const id = loadHoldings(mirror.url).get(key);
    if (id === undefined) continue;
    const h = health.get(mirror.url);
    if (!h || !h.ok || h.latencyMs == null) continue;
    const candidate = score(mirror.url, h.latencyMs);
    if (candidate < bestScore) {
      bestScore = candidate;
      bestUrl = mirror.url;
      bestLatency = h.latencyMs;
      bestId = id;
      bestToken = mirror.streamToken;
      bestIsPrimary = false;
    }
  }

  stuck.set(key, bestUrl);
  if (bestIsPrimary) return null;
  return { url: bestUrl, streamToken: bestToken, trackId: bestId, primary: false };
}

/** Whether routing is even a question on this device. */
export function mirrorsActive(): boolean {
  return read().length > 0;
}

// --- the preference --------------------------------------------------------

const PREF_KEY = 'attackfm-mirror-routing';

/** On by default once a mirror exists: someone who added one wants it used.
 *  The switch is for the case where they want to hear a specific box. */
export function routingPref(): boolean {
  try {
    const stored = localStorage.getItem(PREF_KEY);
    if (stored === 'off') return false;
  } catch {
    // Fall through to the default.
  }
  return true;
}

export function setRoutingPref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    // Applies for this run regardless.
  }
  for (const l of listeners) l();
}

// --- the heartbeat ---------------------------------------------------------

/** How often to re-time the boxes. Latency changes when the phone changes
 *  network, which is an event measured in minutes, not seconds. */
// One second, by request: the dot is a live heartbeat now, not a minute-old
// reading. The probe is a tiny cache-busted /api/server GET, it stands down
// whenever the app is hidden (the check below runs per tick), and the
// holdings refresh keeps its own fifteen-minute clock - only the health
// reading runs hot.
const PROBE_EVERY_MS = 1_000;
/** How often to re-ask a mirror what it holds. A mirror gains songs slowly
 *  (a sync run), and the delta makes a settled pass nearly free. */
const HOLDINGS_EVERY_MS = 15 * 60_000;

/**
 * Keep the routing inputs current for as long as a session is live.
 *
 * Both timers stand down while the app is in the background: a phone in a
 * pocket has nothing to route, and the probe is the kind of small repeating
 * request that adds up to a battery complaint. Returns its own cleanup.
 */
export function startMirrorHeartbeat(session: ServerSession): () => void {
  let stopped = false;
  const control = new AbortController();
  let lastHoldings = 0;
  // At one beat per second, a probe outliving its tick must not stack: a
  // server slow enough to hang the probe is exactly when the next ticks
  // arrive before the last answer - one beat in flight at a time.
  let beating = false;

  const beat = async () => {
    if (stopped || beating || document.hidden) return;
    beating = true;
    try {
      await beatOnce();
    } finally {
      beating = false;
    }
  };

  const beatOnce = async () => {
    const mirrors = read();
    // The session server is probed even with NO mirrors configured: the
    // header's dot reads this heartbeat, and skipping the probe left the
    // dot inventing a green it had never once verified.
    //
    // And it FEEDS REACHABILITY - the once-a-second probe is the most
    // frequent network traffic in the app, and for a long time it taught the
    // down-flag nothing because it is a raw fetch that request() never sees.
    // The flag flipped only after two JSON calls timed out, which offline
    // could take arbitrarily long, and every gate that declines the local
    // copy in the server's favour kept declining into a void. Two silent
    // beats now settle it.
    const home = await probe(session.url, control.signal);
    if (home === null) noteServerSilent();
    else noteServerAnswered();
    await probeAll(mirrors.map((m) => m.url), control.signal);
    if (mirrors.length === 0) return;
    if (stopped) return;
    if (Date.now() - lastHoldings > HOLDINGS_EVERY_MS) {
      lastHoldings = Date.now();
      for (const mirror of mirrors) {
        if (stopped) break;
        await refreshHoldings(mirror, control.signal);
      }
    }
  };

  void beat();
  const timer = window.setInterval(() => void beat(), PROBE_EVERY_MS);
  // Coming back to the app is the moment the answer is most likely stale -
  // it is usually also the moment the network changed.
  const onVisible = () => {
    if (!document.hidden) void beat();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    control.abort();
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
