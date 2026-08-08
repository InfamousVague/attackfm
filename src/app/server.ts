/**
 * The client half of the streaming server.
 *
 * The design goal here was that the *player* should not learn anything. It
 * already plays whatever URL it is handed through an `<audio>` element with
 * `crossOrigin="anonymous"`, and it already reads levels off a CORS-clean
 * remote source - the demo stream it opens with is exactly that. So a remote
 * track is modelled as a track whose `path` happens to be an `afm://` URI:
 * every surface that keys on path (favourites, the table, the search, the
 * queue) keeps working untouched, and the one place that turns a path into
 * something playable - `loadAudioUrl` - learns the new scheme.
 *
 * Two credentials come back from a sign-in and they are used differently:
 * the session token rides an Authorization header on the JSON calls, and the
 * stream token goes in the query string of media URLs, because `<audio src>`
 * and `<img src>` cannot carry headers. See the server's `auth.rs` for why
 * that is a separate, expiring, read-only capability rather than the session
 * token in a less careful place.
 */

import type { Track } from './tauri.ts';

/** The `path` scheme that marks a track as living on a server. */
export const REMOTE_SCHEME = 'afm://';

export function isRemotePath(path: string): boolean {
  return path.startsWith(REMOTE_SCHEME);
}

export function remotePath(trackId: number): string {
  return `${REMOTE_SCHEME}${trackId}`;
}

export function trackIdFromPath(path: string): number | null {
  if (!isRemotePath(path)) return null;
  const id = Number(path.slice(REMOTE_SCHEME.length));
  return Number.isFinite(id) ? id : null;
}

/** A signed-in connection. Everything the app needs to talk to one server. */
export interface ServerSession {
  /** Origin with no trailing slash, e.g. `https://music.example.com`. */
  url: string;
  token: string;
  streamToken: string;
  username: string;
  isAdmin: boolean;
}

/** What a server says about itself before anyone has signed in. */
export interface ServerInfo {
  name: string;
  version: string;
  api: number;
  /** True when no account exists yet - the first visitor makes the admin. */
  needsSetup: boolean;
  /** Whether the box has an ffmpeg, and so whether to offer a quality choice. */
  transcode: boolean;
  tracks: number;
}

/** Trims a user-typed address into an origin the fetches can be built on. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  // A bare host is the common way to type this; assume TLS, since anything
  // reachable from a phone should have it.
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** True when the failure was "your credentials are no longer good". */
export function isAuthError(error: unknown): boolean {
  return error instanceof ServerError && (error.status === 401 || error.status === 403);
}

async function request<T>(
  url: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const response = await fetch(`${url}${path}`, { ...rest, headers });
  if (!response.ok) {
    // The server answers errors as plain text, which is what belongs in a
    // toast; a body that will not read is not worth failing twice over.
    const detail = await response.text().catch(() => '');
    throw new ServerError(response.status, detail || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** Asks a server what it is. The one call that needs no credentials. */
export async function fetchServerInfo(url: string, signal?: AbortSignal): Promise<ServerInfo> {
  return request<ServerInfo>(url, '/api/server', { signal });
}

interface LoginReply {
  token: string;
  streamToken: string;
  user: { id: number; username: string; isAdmin: boolean };
}

export async function login(url: string, username: string, password: string): Promise<ServerSession> {
  const reply = await request<LoginReply>(url, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  return {
    url,
    token: reply.token,
    streamToken: reply.streamToken,
    username: reply.user.username,
    isAdmin: reply.user.isAdmin,
  };
}

/** Creates an account. Open on a fresh server; admin-only after that. */
export async function register(
  url: string,
  username: string,
  password: string,
  token?: string,
): Promise<void> {
  await request(url, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    token,
  });
}

export async function logout(session: ServerSession): Promise<void> {
  // Best-effort: the local session is dropped either way, and a server that
  // cannot be reached should not trap somebody in a signed-in state.
  await request(session.url, '/api/auth/logout', { method: 'POST', token: session.token }).catch(
    () => {},
  );
}

/**
 * Mints a fresh stream token. Called when a media URL starts coming back 401,
 * which is how a stream token that aged out renews without a re-login.
 */
export async function refreshStreamToken(session: ServerSession): Promise<string> {
  const me = await request<{ streamToken: string }>(session.url, '/api/me', {
    token: session.token,
  });
  return me.streamToken;
}

// --- the library ----------------------------------------------------------

/** A track as the server sends it. */
export interface RemoteTrack {
  id: number;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  trackNo: number | null;
  discNo: number | null;
  year: number | null;
  genre: string;
  lyrics: string;
  duration: number | null;
  codec: string;
  lossless: boolean;
  sampleRate: number | null;
  bitDepth: number | null;
  channels: number | null;
  bitrate: number | null;
  sizeBytes: number;
  addedAt: number;
  artId: string | null;
  rev: number;
}

export interface LibraryDelta {
  rev: number;
  more: boolean;
  tracks: RemoteTrack[];
  removed: number[];
}

/** One page of "what changed since rev N". */
export async function fetchLibraryDelta(
  session: ServerSession,
  since: number,
  signal?: AbortSignal,
): Promise<LibraryDelta> {
  return request<LibraryDelta>(session.url, `/api/library?since=${since}`, {
    token: session.token,
    signal,
  });
}

/** The URL an `<audio>` element plays: the original file, byte-ranged. */
export function streamUrl(session: ServerSession, trackId: number): string {
  return `${session.url}/api/stream/${trackId}?t=${encodeURIComponent(session.streamToken)}`;
}

/**
 * The URL for a re-encoded stream, for a metered connection. Not seekable by
 * range - a live encode has no addressable end - so a seek is a fresh request
 * with a new `seek`.
 */
export function transcodeUrl(
  session: ServerSession,
  trackId: number,
  bitrate: number,
  seek = 0,
): string {
  const at = seek > 0 ? `&seek=${seek.toFixed(3)}` : '';
  return `${session.url}/api/transcode/${trackId}?t=${encodeURIComponent(session.streamToken)}&bitrate=${bitrate}${at}`;
}

export function artUrl(session: ServerSession, artId: string): string {
  return `${session.url}/api/art/${encodeURIComponent(artId)}?t=${encodeURIComponent(session.streamToken)}`;
}

/**
 * Turns a server row into the Track the rest of the app already understands.
 *
 * `path` becomes the `afm://` URI, which is what keeps every path-keyed
 * surface - favourites, the queue, the table's row ids - working without
 * knowing a server exists.
 */
export function toTrack(session: ServerSession, remote: RemoteTrack): Track {
  return {
    path: remotePath(remote.id),
    title: remote.title,
    artist: remote.artist,
    album: remote.album,
    duration: remote.duration,
    trackNo: remote.trackNo,
    addedAt: remote.addedAt,
    artwork: remote.artId ? artUrl(session, remote.artId) : null,
    genre: remote.genre,
    lyrics: remote.lyrics,
    lossless: remote.lossless,
    codec: remote.codec,
    sampleRate: remote.sampleRate,
    bitDepth: remote.bitDepth,
    sizeBytes: remote.sizeBytes,
  };
}

// --- sync state -----------------------------------------------------------

/**
 * The cached index, so a relaunch shows the library before the network answers
 * - the remote counterpart of the on-disk index cache the local scanner keeps.
 * Stored per server URL, so switching servers does not blend two libraries.
 */
const CACHE_PREFIX = 'attackfm-remote-index:';

interface CachedIndex {
  rev: number;
  tracks: RemoteTrack[];
}

function cacheKey(url: string): string {
  return `${CACHE_PREFIX}${url}`;
}

export function loadCachedIndex(url: string): CachedIndex {
  try {
    const raw = localStorage.getItem(cacheKey(url));
    if (!raw) return { rev: 0, tracks: [] };
    const parsed = JSON.parse(raw) as Partial<CachedIndex>;
    if (typeof parsed.rev !== 'number' || !Array.isArray(parsed.tracks)) return { rev: 0, tracks: [] };
    return { rev: parsed.rev, tracks: parsed.tracks };
  } catch {
    return { rev: 0, tracks: [] };
  }
}

export function saveCachedIndex(url: string, index: CachedIndex): void {
  try {
    localStorage.setItem(cacheKey(url), JSON.stringify(index));
  } catch {
    // A library too big for the storage quota still works; it just re-syncs
    // from scratch next launch instead of opening instantly.
  }
}

export function clearCachedIndex(url: string): void {
  try {
    localStorage.removeItem(cacheKey(url));
  } catch {
    // Nothing to do - a cache that will not clear is re-validated by rev anyway.
  }
}

/**
 * Drains every page of the delta and folds it into the cached index.
 *
 * Returns the whole library, not just what changed: callers want the list to
 * render, and the incremental part is a transport detail. `onProgress` reports
 * pages as they land so a first sync of a big library can show movement.
 */
export async function syncLibrary(
  session: ServerSession,
  options: {
    signal?: AbortSignal;
    onProgress?: (count: number) => void;
  } = {},
): Promise<RemoteTrack[]> {
  const cached = loadCachedIndex(session.url);
  const byId = new Map(cached.tracks.map((t) => [t.id, t] as const));
  let rev = cached.rev;

  // Bounded rather than `while (true)`: a server that kept answering `more`
  // would otherwise spin here forever.
  for (let page = 0; page < 200; page += 1) {
    const delta = await fetchLibraryDelta(session, rev, options.signal);
    for (const track of delta.tracks) byId.set(track.id, track);
    for (const id of delta.removed) byId.delete(id);
    rev = delta.rev;
    options.onProgress?.(byId.size);
    if (!delta.more) break;
  }

  const tracks = [...byId.values()];
  saveCachedIndex(session.url, { rev, tracks });
  return tracks;
}

// --- listening state ------------------------------------------------------

export async function setRemoteFavorite(
  session: ServerSession,
  trackId: number,
  favorite: boolean,
): Promise<void> {
  await request(session.url, `/api/favorites/${trackId}`, {
    method: 'PUT',
    body: JSON.stringify({ favorite }),
    token: session.token,
  });
}

export async function fetchRemoteFavorites(session: ServerSession): Promise<number[]> {
  const reply = await request<{ tracks: number[] }>(session.url, '/api/favorites', {
    token: session.token,
  });
  return reply.tracks;
}

/** Tells the server where the listener got to, so another device can resume. */
export async function reportPosition(
  session: ServerSession,
  trackId: number,
  positionMs: number,
): Promise<void> {
  await request(session.url, '/api/play-state', {
    method: 'POST',
    body: JSON.stringify({ trackId, positionMs: Math.round(positionMs) }),
    token: session.token,
  });
}

/** Asks the server to re-walk its music folder. */
export async function requestScan(session: ServerSession): Promise<void> {
  await request(session.url, '/api/scan', { method: 'POST', token: session.token });
}

export interface ScanStatus {
  running: boolean;
  seen: number;
  total: number;
  tracks: number;
  bytesLabel: string;
  rev: number;
}

export async function fetchScanStatus(session: ServerSession): Promise<ScanStatus> {
  return request<ScanStatus>(session.url, '/api/scan', { token: session.token });
}

// --- uploading ------------------------------------------------------------

/** How much of a file goes up per request. Small enough that a dropped phone
 * connection loses a slice rather than a track. */
const UPLOAD_CHUNK = 1024 * 1024;

/**
 * Sends one file, resuming from whatever the server already holds.
 *
 * Returns the library path it landed on. Progress is reported as a 0-1
 * fraction so a caller can drive a bar without knowing the chunk size.
 */
export async function uploadFile(
  session: ServerSession,
  file: { name: string; size: number; slice: (start: number, end: number) => Promise<Uint8Array> },
  options: { signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<string> {
  const init = await request<{ uploadId: string }>(session.url, '/api/upload/init', {
    method: 'POST',
    body: JSON.stringify({ filename: file.name, size: file.size }),
    token: session.token,
    signal: options.signal,
  });

  // The server is asked what it already has rather than assuming zero, so a
  // retried upload picks up mid-file.
  const held = await request<{ received: number }>(
    session.url,
    `/api/upload/${init.uploadId}`,
    { token: session.token, signal: options.signal },
  );

  let offset = held.received;
  while (offset < file.size) {
    const end = Math.min(offset + UPLOAD_CHUNK, file.size);
    const bytes = await file.slice(offset, end);
    const response = await fetch(
      `${session.url}/api/upload/${init.uploadId}?offset=${offset}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${session.token}` },
        // A fresh ArrayBuffer, so a view into a larger pooled buffer never
        // sends more than its own slice.
        body: bytes.slice().buffer as ArrayBuffer,
        signal: options.signal,
      },
    );
    if (!response.ok) {
      throw new ServerError(response.status, await response.text().catch(() => 'upload failed'));
    }
    const progress = (await response.json()) as { received: number };
    offset = progress.received;
    options.onProgress?.(file.size > 0 ? offset / file.size : 1);
  }

  const done = await request<{ path: string }>(
    session.url,
    `/api/upload/${init.uploadId}/finish`,
    { method: 'POST', token: session.token, signal: options.signal },
  );
  return done.path;
}
