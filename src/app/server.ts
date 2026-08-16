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

export class ServerError extends Error {
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

/**
 * The Spotify Canvas clip for a track, or null when there is none (or the
 * server has no Spotify session configured). Best-effort and quiet: any failure
 * resolves to null so the now-playing screen just keeps its blurred cover.
 */
export async function fetchCanvas(
  session: ServerSession,
  title: string,
  artist: string,
  signal?: AbortSignal,
  trackId?: number | null,
): Promise<string | null> {
  try {
    const params: Record<string, string> = { title, artist };
    // Telling the server which track this is lets it keep the clip beside the
    // song, so every later play is served from your own library rather than
    // asking Spotify again.
    if (typeof trackId === 'number') params.trackId = String(trackId);
    const reply = await request<{ url: string | null }>(
      session.url,
      `/api/canvas?${new URLSearchParams(params).toString()}`,
      { token: session.token, signal },
    );
    const url = reply.url ?? null;
    if (!url) return null;
    // A stored clip comes back as a path on this server. It needs the stream
    // token in the query, because a <video src> cannot send a header.
    if (url.startsWith('/')) {
      return `${session.url}${url}?t=${encodeURIComponent(session.streamToken)}`;
    }
    return url;
  } catch {
    return null;
  }
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

/**
 * Bind your central identity to the account you already have on this server -
 * the owner's migration, so an existing library stays yours and you enter as
 * yourself from then on. Needs both proofs: the server session and the registry
 * token.
 */
export async function linkAccount(
  url: string,
  serverToken: string,
  registryToken: string,
): Promise<{ handle: string }> {
  return request<{ ok: boolean; handle: string }>(url, '/api/registry/link', {
    method: 'POST',
    token: serverToken,
    body: JSON.stringify({ token: registryToken }),
  });
}

/**
 * Sign into a server with a central-registry identity instead of a password.
 * The server verifies the registry token, admits the account (invite-gated the
 * first time), and answers with the same session a password login would - so
 * the rest of the app is none the wiser about which door was used.
 */
export async function enterServer(
  url: string,
  registryToken: string,
  invite?: string,
): Promise<ServerSession> {
  const reply = await request<LoginReply>(url, '/api/registry/enter', {
    method: 'POST',
    body: JSON.stringify({ token: registryToken, invite: invite ?? '' }),
  });
  return {
    url,
    token: reply.token,
    streamToken: reply.streamToken,
    username: reply.user.username,
    isAdmin: reply.user.isAdmin,
  };
}

/** What `POST /api/pair/start` hands a signed-in device: a code to show. */
export interface PairCode {
  code: string;
  /** Seconds the code stays good for. */
  expiresIn: number;
}

/**
 * Mints a one-time pairing code on the server this session is signed into, so
 * another device can link without a password. The desktop shows the code (as a
 * QR and as text); the phone spends it with {@link pairClaim}.
 */
export async function pairStart(session: ServerSession): Promise<PairCode> {
  return request<PairCode>(session.url, '/api/pair/start', {
    method: 'POST',
    token: session.token,
  });
}

/**
 * Turns a pairing code into a full session on `url` - the same token pair a
 * password sign-in would return, for the account that minted the code. Used by
 * the phone's "log in with a code" path.
 */
export async function pairClaim(url: string, code: string): Promise<ServerSession> {
  const reply = await request<LoginReply>(url, '/api/pair/claim', {
    method: 'POST',
    body: JSON.stringify({ code }),
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
  /** 'music' or 'book' - which shelf the row lives on. Absent from servers
   *  that predate audiobooks, which only ever held music. */
  kind?: 'music' | 'book';
  /** Chapter markers for a single-file audiobook. Absent/empty otherwise; older
   *  servers never send it. */
  chapters?: { title: string; startMs: number }[];
  /** Collector attribution - see Track. Optional: older servers never send it. */
  curatorUserId?: number | null;
  curatorPromoted?: boolean;
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
  fx: string | null = null,
): string {
  const at = seek > 0 ? `&seek=${seek.toFixed(3)}` : '';
  // Effect NAMES, which the server looks up in its own table; it never accepts
  // a filter. Part of the URL rather than a header so the media element - which
  // sends no headers of ours - carries it, and so a change of rack is a change
  // of URL, which is what makes the source reload.
  const with_fx = fx ? `&fx=${encodeURIComponent(fx)}` : '';
  return `${session.url}/api/transcode/${trackId}?t=${encodeURIComponent(session.streamToken)}&bitrate=${bitrate}${at}${with_fx}`;
}

/**
 * Re-fetching a track that came down as the wrong recording.
 *
 * The server searches the catalogues with the track's OWN tags - which say
 * what was wanted, even when the audio is a live cut or a cover - downloads
 * several alternates side by side into staging, and holds them there until
 * one is chosen. Nothing in the library changes until `keepCandidate`.
 */
export interface RefetchCandidate {
  index: number;
  source: string;
  title: string;
  artist: string;
  album: string;
  state: 'queued' | 'downloading' | 'ready' | 'failed';
  error: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  lossless: boolean;
  codec: string;
  /** An earlier candidate whose audio this one matches. */
  sameAs: number | null;
}

export interface RefetchJob {
  id: string;
  trackId: number;
  state: 'hunting' | 'ready' | 'done' | 'failed';
  error: string | null;
  current: {
    id: number;
    title: string;
    artist: string;
    album: string;
    durationMs: number | null;
    lossless: boolean;
    codec: string;
  };
  candidates: RefetchCandidate[];
}

export async function startRefetch(
  session: ServerSession,
  trackId: number,
): Promise<RefetchJob> {
  return request<RefetchJob>(session.url, `/api/refetch/track/${trackId}`, {
    method: 'POST',
    token: session.token,
  });
}

export async function fetchRefetch(
  session: ServerSession,
  id: string,
  signal?: AbortSignal,
): Promise<RefetchJob> {
  return request<RefetchJob>(session.url, `/api/refetch/${encodeURIComponent(id)}`, {
    token: session.token,
    signal,
  });
}

/** The staged audio for one candidate, for the preview player. Range-capable,
 *  so the modal's scrubber works - skipping to the middle is how a live take
 *  gives itself away. */
export function refetchAudioUrl(session: ServerSession, id: string, index: number): string {
  return `${session.url}/api/refetch/${encodeURIComponent(id)}/audio/${index}?t=${encodeURIComponent(session.streamToken)}`;
}

/** This one is the song: file it, move the old track's history onto it, and
 *  scrap the rest. */
export async function keepCandidate(
  session: ServerSession,
  id: string,
  index: number,
): Promise<{ trackId: number; replaced: number }> {
  return request(session.url, `/api/refetch/${encodeURIComponent(id)}/keep`, {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ index }),
  });
}

/** None of them were right. Everything staged goes; the library is untouched. */
export async function scrapRefetch(session: ServerSession, id: string): Promise<void> {
  await request(session.url, `/api/refetch/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token: session.token,
  });
}

export function artUrl(session: ServerSession, artId: string): string {
  return `${session.url}/api/art/${encodeURIComponent(artId)}?t=${encodeURIComponent(session.streamToken)}`;
}

/**
 * A downscaled variant of an art URL, for the surfaces that draw covers small
 * - table thumbs, shelf cards - where fetching the full embedded picture
 * (often megabytes) for a hundred-pixel square is most of the art bill. The
 * server keeps `{id}@{size}.jpg` beside the original; a server that predates
 * the variants ignores the unknown parameter and serves the original, so this
 * needs no capability check. 160 suits thumbs, 640 suits cards; the Now
 * Playing hero and the lock screen keep the full-size original.
 */
export function artSized(url: string | null, px: 160 | 640): string | null {
  if (!url) return null;
  // Only server art has variants. A local track's cover is a blob: object
  // URL, and a query string BREAKS one - the blob store keys on the full
  // serialized URL - so anything that is not http(s) passes through whole.
  if (!/^https?:/i.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}size=${px}`;
}

/**
 * When the stream token embedded in every media URL runs out, in epoch
 * milliseconds. The token's shape is `user.epoch.expiry.sig`; anything
 * unreadable counts as already expired, which safely routes callers into the
 * renewal path.
 */
export function streamTokenExpiresAt(token: string): number {
  const expiry = Number(token.split('.')[2]);
  return Number.isFinite(expiry) ? expiry * 1000 : 0;
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
    albumArtist: remote.albumArtist || null,
    album: remote.album,
    duration: remote.duration,
    trackNo: remote.trackNo,
    discNo: remote.discNo,
    year: remote.year,
    addedAt: remote.addedAt,
    artwork: remote.artId ? artUrl(session, remote.artId) : null,
    genre: remote.genre,
    lyrics: remote.lyrics,
    lossless: remote.lossless,
    codec: remote.codec,
    sampleRate: remote.sampleRate,
    bitDepth: remote.bitDepth,
    sizeBytes: remote.sizeBytes,
    curatorUserId: remote.curatorUserId ?? null,
    curatorPromoted: remote.curatorPromoted ?? false,
    kind: remote.kind ?? 'music',
    chapters: remote.chapters?.length ? remote.chapters : undefined,
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

// The index lives in three places, cheapest first:
//
//  - a module-level Map, so every sync pass inside one run reads memory - the
//    heartbeat must never depend on persistence working;
//  - IndexedDB, whose quota holds libraries localStorage cannot. The old
//    localStorage copy hit WKWebView's ~5MB ceiling somewhere around 1,500
//    lyric-bearing tracks, after which the save failed SILENTLY, rev never
//    persisted, and every launch - and, worse, every 30-second heartbeat -
//    re-downloaded the entire library JSON. That was most of "the app got
//    slow once the library got big";
//  - the legacy localStorage key, read once for migration and then deleted,
//    which also hands its quota back to the small caches that still live
//    there (sessions, feed cards, search recents).
const memIndex = new Map<string, CachedIndex>();

const IDB_NAME = 'attackfm';
const IDB_STORE = 'remoteIndex';

function openIndexDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(IDB_STORE)) {
        req.result.createObjectStore(IDB_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
  });
}

async function idbRead(url: string): Promise<CachedIndex | null> {
  const db = await openIndexDb();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(url);
      req.onsuccess = () => {
        const parsed = req.result as Partial<CachedIndex> | undefined;
        resolve(
          parsed && typeof parsed.rev === 'number' && Array.isArray(parsed.tracks)
            ? { rev: parsed.rev, tracks: parsed.tracks }
            : null,
        );
      };
      req.onerror = () => reject(req.error ?? new Error('indexedDB read failed'));
    });
  } finally {
    db.close();
  }
}

async function idbWrite(url: string, index: CachedIndex | null): Promise<void> {
  const db = await openIndexDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const store = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE);
      const req = index ? store.put(index, url) : store.delete(url);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error ?? new Error('indexedDB write failed'));
    });
  } finally {
    db.close();
  }
}

/** The in-memory index; whatever hydrate() has seeded, or empty. */
export function loadCachedIndex(url: string): CachedIndex {
  return memIndex.get(url) ?? { rev: 0, tracks: [] };
}

/**
 * Fills the in-memory index from disk - IndexedDB, or the legacy localStorage
 * copy once, migrating it - and returns it. Call before the first sync so the
 * first delta asks "since rev N", not "everything".
 */
export async function hydrateCachedIndex(url: string): Promise<CachedIndex> {
  const inMemory = memIndex.get(url);
  if (inMemory) return inMemory;
  let index: CachedIndex | null = null;
  try {
    index = await idbRead(url);
  } catch {
    // A store that will not open costs the fast start, not the library.
  }
  if (index) {
    // IndexedDB is authoritative now; a legacy localStorage copy left behind
    // (a migration interrupted mid-write) is just quota spent twice.
    try {
      localStorage.removeItem(cacheKey(url));
    } catch {
      // Not worth anything if it will not go.
    }
  }
  if (!index) {
    try {
      const raw = localStorage.getItem(cacheKey(url));
      const parsed = raw ? (JSON.parse(raw) as Partial<CachedIndex>) : null;
      if (parsed && typeof parsed.rev === 'number' && Array.isArray(parsed.tracks)) {
        index = { rev: parsed.rev, tracks: parsed.tracks };
        void idbWrite(url, index).then(() => localStorage.removeItem(cacheKey(url))).catch(() => {});
      }
    } catch {
      // Unreadable legacy cache: start from zero, same as a fresh install.
    }
  }
  const settled = index ?? { rev: 0, tracks: [] };
  memIndex.set(url, settled);
  return settled;
}

export function saveCachedIndex(url: string, index: CachedIndex): void {
  memIndex.set(url, index);
  void idbWrite(url, index).catch(() => {
    // Persistence failing still leaves the memory copy carrying this run.
  });
}

export function clearCachedIndex(url: string): void {
  memIndex.delete(url);
  void idbWrite(url, null).catch(() => {});
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
): Promise<{ tracks: RemoteTrack[]; changed: boolean }> {
  const cached = loadCachedIndex(session.url);
  const byId = new Map(cached.tracks.map((t) => [t.id, t] as const));
  let rev = cached.rev;
  let changed = false;

  // Bounded rather than `while (true)`: a server that kept answering `more`
  // would otherwise spin here forever.
  for (let page = 0; page < 200; page += 1) {
    const delta = await fetchLibraryDelta(session, rev, options.signal);
    if (delta.tracks.length > 0 || delta.removed.length > 0) changed = true;
    for (const track of delta.tracks) byId.set(track.id, track);
    for (const id of delta.removed) byId.delete(id);
    rev = delta.rev;
    options.onProgress?.(byId.size);
    if (!delta.more) break;
  }

  const tracks = [...byId.values()];
  // The settled case - the heartbeat's usual answer - writes nothing and lets
  // the caller skip its own re-render; a whole quiet pass costs one request.
  if (changed || rev !== cached.rev) saveCachedIndex(session.url, { rev, tracks });
  return { tracks, changed };
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

/** Every resume position this account has, newest first - the audiobook
 *  shelf's "continue where you left off". */
export interface PlayState {
  trackId: number;
  positionMs: number;
  updatedAt: number;
}

export async function fetchPlayStates(session: ServerSession): Promise<PlayState[]> {
  const reply = await request<{ states: PlayState[] }>(session.url, '/api/play-state', {
    token: session.token,
  });
  return reply.states;
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
  /** Library bytes on disk, raw and human-labelled. */
  bytes: number;
  bytesLabel: string;
  /** The AFM_QUOTA_GB ceiling in bytes; 0 means uncapped. */
  quota: number;
  rev: number;
}

export async function fetchScanStatus(session: ServerSession): Promise<ScanStatus> {
  return request<ScanStatus>(session.url, '/api/scan', { token: session.token });
}

// --- the server dashboard ----------------------------------------------------

/** The numbers behind Settings > Server, from `GET /api/stats` in one call.
 * Disk fields are null when the box could not answer (no `df`); the whole
 * fetch fails on a server that predates the endpoint - callers fall back to
 * the scan status they already poll. */
export interface ServerStats {
  version: string;
  name: string;
  uptimeSecs: number;
  tracks: number;
  users: number;
  bytesUsed: number;
  bytesLabel: string;
  quotaBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  transcode: boolean;
  importsQueued: number;
  importsActive: number;
}

export async function fetchServerStats(session: ServerSession): Promise<ServerStats> {
  return request<ServerStats>(session.url, '/api/stats', { token: session.token });
}

// --- user management (admin) -------------------------------------------------

export interface ServerUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

/** The account list. Admin only - a listener gets a 403. */
export async function fetchUsers(session: ServerSession): Promise<ServerUser[]> {
  const reply = await request<{ users: ServerUser[] }>(session.url, '/api/users', {
    token: session.token,
  });
  return reply.users;
}

/** Removes an account outright. The server refuses self-deletion. */
export async function deleteUser(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/users/${id}`, { method: 'DELETE', token: session.token });
}

// --- reclaiming disk (admin) -------------------------------------------------

export interface TrashState {
  files: number;
  bytes: number;
}

/**
 * Quarantines tracks: the files move to the library's trash and the rows are
 * tombstoned, so every client's delta sync drops them.
 *
 * This frees NO space on its own - that is deliberate, and the reason the
 * reply reports bytes rather than pretending. `purgeTrash` is the second,
 * separate act that actually returns the disk.
 */
export async function removeTracks(
  session: ServerSession,
  ids: number[],
): Promise<{ removed: number; bytes: number; rev: number }> {
  return request(session.url, '/api/library/remove', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ ids }),
  });
}

/** What is sitting in the trash, and so what emptying it would give back. */
export async function fetchTrash(session: ServerSession): Promise<TrashState> {
  return request<TrashState>(session.url, '/api/library/trash', { token: session.token });
}

/** Unlinks the trash. The one call here that cannot be undone. */
export async function purgeTrash(session: ServerSession): Promise<TrashState> {
  return request<TrashState>(session.url, '/api/library/trash/purge', {
    method: 'POST',
    token: session.token,
  });
}

/** Kills every stream token the account holds - each device must sign in again
 * to keep listening. The account itself stays. */
export async function revokeUserStreams(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/users/${id}/revoke`, { method: 'POST', token: session.token });
}

// --- the home feed -----------------------------------------------------------

/** The home page's shelves, as track ids resolved against the synced library. */
export interface HomeFeed {
  recent: number[];
  heavy: number[];
  /** The same songs with their play counts, most-played first. Absent on
   *  servers older than this field. */
  heavyPlays?: { id: number; plays: number }[];
  fresh: number[];
  /** Recently-played albums, each a full ordered track-id list to play as-is. */
  jumpBackIn: number[][];
  /** The user's top artist names this month. */
  topArtists: string[];
  mixes: { id: string; title: string; blurb: string; trackIds: number[]; flavor: 'ai' | 'heuristic' }[];
  /** Whether a local model is wired up server-side. */
  ai: boolean;
}

export async function fetchHome(session: ServerSession): Promise<HomeFeed> {
  return request<HomeFeed>(session.url, '/api/home', { token: session.token });
}

// --- DJ --------------------------------------------------------------------

/** One run of the DJ set: a spoken line, then the tracks it introduces. */
export interface DjBlock {
  say: string;
  trackIds: number[];
}

export interface DjSet {
  /** Whether a model wrote the patter (false = a wordless set of good picks). */
  ai: boolean;
  /** The vibe it was steered toward, echoed back. */
  vibe: string;
  blocks: DjBlock[];
}

/**
 * A continuous DJ set drawn from the listener's OWN library: runs of tracks
 * with a spoken line opening each. `seed` steers the whole thing toward a vibe
 * ("something mellow for a rainy morning"); empty just mirrors recent listening.
 */
export async function fetchDj(session: ServerSession, seed = '', count?: number): Promise<DjSet> {
  const params = new URLSearchParams();
  if (seed.trim()) params.set('seed', seed.trim());
  if (count) params.set('count', String(count));
  const qs = params.toString();
  const out = await request<Partial<DjSet>>(
    session.url,
    `/api/dj${qs ? `?${qs}` : ''}`,
    { token: session.token },
  );
  return { ai: out.ai ?? false, vibe: out.vibe ?? seed, blocks: out.blocks ?? [] };
}

// --- friends ---------------------------------------------------------------

export interface Friend {
  userId: number;
  username: string;
}

/** A pending ask, in whichever direction. `userId` is the OTHER person. */
export interface FriendRequest {
  id: number;
  userId: number;
  username: string;
}

export interface FriendsFeed {
  friends: Friend[];
  /** Asks aimed at you, waiting on your answer. */
  incoming: FriendRequest[];
  /** Asks you sent, waiting on theirs. */
  outgoing: FriendRequest[];
}

export async function fetchFriends(session: ServerSession): Promise<FriendsFeed> {
  const out = await request<Partial<FriendsFeed>>(session.url, '/api/friends', {
    token: session.token,
  });
  return { friends: out.friends ?? [], incoming: out.incoming ?? [], outgoing: out.outgoing ?? [] };
}

/** Asks someone to be friends, by the name they signed up with. Resolves to
 *  whether it settled immediately - it does when they had already asked you. */
export async function sendFriendRequest(
  session: ServerSession,
  username: string,
): Promise<{ friends: boolean }> {
  const out = await request<{ friends?: boolean }>(session.url, '/api/friends/requests', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  return { friends: out.friends === true };
}

export async function acceptFriendRequest(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/friends/requests/${id}/accept`, {
    token: session.token,
    method: 'POST',
  });
}

/** Turns down an ask aimed at you, or withdraws one you sent. */
export async function declineFriendRequest(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/friends/requests/${id}/decline`, {
    token: session.token,
    method: 'POST',
  });
}

export async function removeFriend(session: ServerSession, userId: number): Promise<void> {
  await request(session.url, `/api/friends/${userId}`, {
    token: session.token,
    method: 'DELETE',
  });
}

// --- jams ------------------------------------------------------------------

/** A live listening room. `positionMs` arrives already carried forward to the
 *  moment it was read, so a follower can seek straight to it. */
export interface Jam {
  id: string;
  hostId: number;
  hostName: string;
  members: string[];
  memberCount: number;
  trackId: number | null;
  positionMs: number;
  playing: boolean;
  queue: number[];
  /** Who asked for a track, by track id: "added by Kayla" on the row. */
  addedBy?: Record<string, string>;
  updatedAt: number;
}

export interface JamsFeed {
  /** The jam you are in, if any - hosting or following. */
  current: Jam | null;
  /** Jams your friends are hosting that you could join. */
  friends: Jam[];
}

export async function fetchJams(session: ServerSession): Promise<JamsFeed> {
  const out = await request<Partial<JamsFeed>>(session.url, '/api/jams', { token: session.token });
  return { current: out.current ?? null, friends: out.friends ?? [] };
}

export async function startJam(session: ServerSession): Promise<Jam> {
  return request<Jam>(session.url, '/api/jams', { token: session.token, method: 'POST' });
}

export async function joinJam(session: ServerSession, id: string): Promise<Jam> {
  return request<Jam>(session.url, `/api/jams/${id}/join`, {
    token: session.token,
    method: 'POST',
  });
}

export async function leaveJam(session: ServerSession, id: string): Promise<void> {
  await request(session.url, `/api/jams/${id}/leave`, { token: session.token, method: 'POST' });
}

/** The host's clock, posted as it plays. Members read it and follow. The reply
 *  hands back any track ids members have asked to add since the last beat, for
 *  the host to fold into its own queue. */
export async function pushJamState(
  session: ServerSession,
  id: string,
  state: { trackId: number | null; positionMs: number; playing: boolean; queue?: number[] },
): Promise<number[]> {
  const out = await request<{ additions?: number[] }>(session.url, `/api/jams/${id}/state`, {
    token: session.token,
    method: 'POST',
    body: JSON.stringify(state),
  });
  return out.additions ?? [];
}

/** A member drops a track into the room's queue; the host folds it in on its
 *  next beat. */
export async function addToJamQueue(
  session: ServerSession,
  id: string,
  trackId: number,
): Promise<void> {
  await request(session.url, `/api/jams/${id}/queue`, {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ trackId }),
  });
}

/** One artist's most-played songs, all-time: ids + counts, most-played first.
 * Ids resolve against the synced library like the home feed's shelves do. */
export async function fetchArtistTop(
  session: ServerSession,
  artist: string,
): Promise<{ id: number; plays: number }[]> {
  const out = await request<{ top: { id: number; plays: number }[] }>(
    session.url,
    `/api/artist-top?name=${encodeURIComponent(artist)}`,
    { token: session.token },
  );
  return out.top ?? [];
}

/**
 * What else belongs on one playlist, ranked against the LIST's own character
 * rather than the listener's. `ai` says whether a model is reading lyrics -
 * without one the ranking is tempo and genre alone, and the surface hides
 * itself rather than promise more than it did.
 */
export async function fetchPlaylistSuggestions(
  session: ServerSession,
  playlistId: string,
  signal?: AbortSignal,
): Promise<{ trackIds: number[]; ai: boolean }> {
  return request<{ trackIds: number[]; ai: boolean }>(
    session.url,
    `/api/playlists/${encodeURIComponent(playlistId)}/suggestions`,
    { token: session.token, signal },
  );
}

/**
 * The collector: the curator's buying arm. Status of the autonomous downloads -
 * what it has pulled, how much of its budget is spent, and whether it has had
 * to stop. `userId` is the caller's own id, which is how the client matches
 * `Track.curatorUserId` rows to "mine" without storing ids in the session.
 */
export interface CollectorStatus {
  userId: number;
  enabled: boolean;
  /** Why pulls are stopped: 'cap' when the budget is spent, null when running. */
  halted: 'cap' | null;
  /** Bytes of collector music nobody has adopted yet - what the cap meters. */
  ledgerBytes: number;
  capBytes: number;
  /** The self-tuning dial, 0..1 - how far afield the picks reach right now. */
  exploration: number;
  /** Whether this box can actually import (the downloader tool is present). */
  importable: boolean;
  recent: {
    title: string;
    artist: string;
    kind: 'track' | 'album';
    state: 'queued' | 'landed' | 'promoted' | 'failed';
    at: number;
    /** Why the curator chose it, when the model wrote one. */
    reason: string;
  }[];
}

export async function fetchCollectorStatus(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<CollectorStatus> {
  return request<CollectorStatus>(session.url, '/api/curator/pulls', {
    token: session.token,
    signal,
  });
}

/** Flip the collector for this account (and, as admin, resize the budget). */
export async function setCollectorSettings(
  session: ServerSession,
  settings: { enabled?: boolean; capBytes?: number },
): Promise<void> {
  await request(session.url, '/api/curator/pulls/settings', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify(settings),
  });
}

/**
 * Notifications, and what a listener wants to be told.
 *
 * The kinds are the server's (`push.rs`), and this side never invents one: the
 * prefs reply materialises every kind with where the account stands on it, so
 * a kind added on the server shows up here without a release.
 */
export interface PushPrefs {
  /** kind -> wanted. Unset on the server means on, resolved before it ships. */
  prefs: Record<string, boolean>;
  /** How many devices are registered to receive them. Zero means nothing can
   *  arrive however the switches are set - which is the state worth showing. */
  devices: number;
}

export async function fetchPushPrefs(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<PushPrefs> {
  return request<PushPrefs>(session.url, '/api/push/prefs', { token: session.token, signal });
}

/** One kind, switched. */
export async function setPushPref(
  session: ServerSession,
  kind: string,
  enabled: boolean,
): Promise<void> {
  await request(session.url, '/api/push/prefs', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ kind, enabled }),
  });
}

/** This device asking to be told things. The token comes from the platform,
 *  not from us - see notifications.ts. */
export async function registerPushDevice(
  session: ServerSession,
  token: string,
  platform: string,
  label: string,
): Promise<void> {
  await request(session.url, '/api/push/register', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ token, platform, label }),
  });
}

/** The reverse, on sign-out. */
export async function unregisterPushDevice(
  session: ServerSession,
  token: string,
): Promise<void> {
  await request(session.url, '/api/push/unregister', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ token }),
  });
}

/** One thing the curator thinks you would like but do not own yet. */
export interface Discovery {
  id: string;
  title: string;
  artist: string;
  cover: string;
  url: string;
  preview: string;
  /** The artist of yours it hangs off - the "because you play X" line. */
  seed: string;
  /** Measured off the catalogue's own preview, when one existed. */
  bpm: number | null;
  /** Whether its words were actually read and compared, so the UI can say why
   *  it is here without overclaiming. */
  lyricsRead: boolean;
  score: number;
}

export interface DiscoveryFeed {
  items: Discovery[];
  progress: { pool: number; listened: number };
  /** How many distinct songs you have played inside the taste window, and how
   *  many the model waits for before it has an opinion. Straight from the gate
   *  itself (curator::TASTE_MIN_TRACKS), so the page's ask cannot drift from
   *  the rule. Absent on servers older than this field. */
  taste?: { heard: number; needed: number };
}

/** What the curator found outside your library, best first. */
export async function fetchDiscoveries(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<DiscoveryFeed> {
  return request<DiscoveryFeed>(session.url, '/api/discoveries', {
    token: session.token,
    signal,
  });
}

/** How far a library copy has got. */
export interface MirrorStatus {
  running: boolean;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  note: string;
}

/**
 * Ask THIS server to pull another library into itself.
 *
 * The destination does the work, which is what lets a copy be started from a
 * phone anywhere: the source only has to be reachable, and it already is. The
 * source's credentials travel in the body because the destination has to read
 * a library it has no account on.
 */
export async function startMirror(
  session: ServerSession,
  source: { url: string; token: string; streamToken: string },
  /** Carry only what the source is actually listened to, rather than all of
   *  it. The destination sizes the set to its own free disk. See hot.rs. */
  hot?: { minPlays?: number },
): Promise<void> {
  await request(session.url, '/api/mirror/start', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({
      sourceUrl: source.url,
      token: source.token,
      streamToken: source.streamToken,
      ...(hot ? { hot } : {}),
    }),
  });
}

export interface HotBar {
  minPlays: number;
  tracks: number;
  bytes: number;
}

/**
 * How big the listened-to set is on a server, at each bar - so the size of
 * the thing can be seen before a copy is started rather than discovered
 * while it runs.
 */
export async function fetchHotSummary(source: {
  url: string;
  streamToken: string;
}): Promise<{ bars: HotBar[]; liked: number; libraryTracks: number }> {
  return request(
    source.url,
    `/api/hot/summary?t=${encodeURIComponent(source.streamToken)}`,
    {},
  );
}

export async function fetchMirrorStatus(session: ServerSession): Promise<MirrorStatus> {
  const out = await request<Partial<MirrorStatus>>(session.url, '/api/mirror/status', {
    token: session.token,
  });
  return {
    running: out.running ?? false,
    total: out.total ?? 0,
    copied: out.copied ?? 0,
    skipped: out.skipped ?? 0,
    failed: out.failed ?? 0,
    note: out.note ?? '',
  };
}

/**
 * The deck ran out: tell the server what the verdicts were so it can go and get
 * more shaped by them, instead of waiting out its own six-hourly sweep.
 * Answers as soon as the work is queued, not when it finishes.
 */
export async function dateDone(
  session: ServerSession,
  kept: number[],
  passed: number[],
): Promise<{ seeded: number }> {
  const out = await request<{ seeded?: number }>(session.url, '/api/date/done', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ kept, passed }),
  });
  return { seeded: out.seeded ?? 0 };
}

/** Not for me. Forgotten rather than hidden, so the harvest can replace it. */
export async function dismissDiscovery(session: ServerSession, id: string): Promise<void> {
  await request(session.url, `/api/discoveries/dismiss?id=${encodeURIComponent(id)}`, {
    method: 'POST',
    token: session.token,
  });
}

/** One playlist the curator built from this listener's own history. */
export interface CuratedList {
  slug: string;
  name: string;
  blurb: string;
  trackIds: number[];
  builtAt: number;
}

/** What the always-running curator has done and how far it has got. */
export interface CuratorFeed {
  lists: CuratedList[];
  status: {
    /** "enriching" | "curating" | "idle". */
    phase: string;
    lastCurated: number;
    /** Whether a local model is configured server-side. */
    ai: boolean;
    /** Whether the embedder is answering - i.e. lyrics are being read. */
    embeddings: boolean;
  };
  progress: { checked: number; withTempo: number; withLyrics: number; total: number };
}

export async function fetchCurator(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<CuratorFeed> {
  return request<CuratorFeed>(session.url, '/api/curator', { token: session.token, signal });
}

/** A suggested chart playlist the user can add through the import pipeline. */
export interface Suggestion {
  id: string;
  title: string;
  blurb: string;
  cover: string | null;
  /** The playlist/album/track URL to hand the importer. */
  url: string;
  section: string;
  /** Where it came from ('spotify' | 'deezer'); absent on an older server. */
  source?: string;
  /** What it is ('playlist' | 'album' | 'track'); absent on an older server. */
  kind?: string;
  trackCount: number | null;
  /** Track titles in order, for the preview - absent on an older server. */
  tracks?: string[];
}

export async function fetchDiscover(session: ServerSession): Promise<Suggestion[]> {
  const reply = await request<{ suggestions: Suggestion[] }>(session.url, '/api/discover', {
    token: session.token,
  });
  return reply.suggestions;
}

/** One external catalogue hit (Spotify/Deezer), from `GET /api/search`. A
 *  track or album carries an importable `url`; an artist is a name to search
 *  deeper. */
export interface SearchResult {
  id: string;
  kind: 'track' | 'artist' | 'album';
  title: string;
  subtitle: string;
  cover: string | null;
  /** The link to hand the importer (present for tracks and albums). */
  url: string;
  source: string;
  /**
   * Whether `url` is something the importer can take as PRIMARY input, which
   * today means a Spotify link. A Deezer album is worth showing and cannot be
   * pulled, so the row renders either way and only its Add control reads this.
   */
  importable: boolean;
}

/** Search Spotify and other public sources for new artists and songs. */
export async function searchCatalog(
  session: ServerSession,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const reply = await request<{ results: SearchResult[] }>(
    session.url,
    `/api/search?q=${encodeURIComponent(query)}`,
    { token: session.token, signal },
  );
  return reply.results;
}

/**
 * One thing the user opened from search before, as the server remembers it.
 *
 * Deliberately a flat, self-describing row rather than a reference: a recent
 * has to render as a card the moment the page opens, before the library has
 * synced and whether or not the thing still exists. `key` is what makes it
 * unique within its kind - a track path, an artist name, a playlist id - and
 * is what a tap resolves against when the library does have it.
 */
export interface Recent {
  kind: 'track' | 'artist' | 'album' | 'playlist' | 'genre' | 'catalog';
  key: string;
  title: string;
  subtitle: string;
  cover: string | null;
  url: string;
  /** When it was last opened, epoch milliseconds. */
  at: number;
}

/** What this account has opened from search lately, newest first. */
export async function fetchRecents(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<Recent[]> {
  const reply = await request<{ recents: Recent[] }>(session.url, '/api/recents', {
    token: session.token,
    signal,
  });
  return reply.recents;
}

/** Remember one - or bump it to the front, if it is already there. */
export async function touchRecent(
  session: ServerSession,
  recent: Omit<Recent, 'at'>,
): Promise<void> {
  await request(session.url, '/api/recents', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify(recent),
  });
}

/** Forget one. */
export async function removeRecent(
  session: ServerSession,
  kind: string,
  key: string,
): Promise<void> {
  await request(session.url, '/api/recents/remove', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ kind, key }),
  });
}

/** Forget all of them. */
export async function clearRecents(session: ServerSession): Promise<void> {
  await request(session.url, '/api/recents/clear', {
    method: 'POST',
    token: session.token,
  });
}

/** One release on an artist's page: an album, EP, single or compilation. Its
 *  `url` is an album link the importer takes whole. */
/**
 * A record you own PART of, and what is missing from it.
 *
 * The server has answered this since the gaps work landed - which of an
 * artist's albums you hold some of, the catalogue's tracklist for each, and
 * the difference - and no client had ever asked. It is the honest shape for
 * "most of this album is missing": positions and titles, so the gap can be
 * shown as the songs it actually is rather than a count.
 */
export interface MissingTrack {
  position: number;
  title: string;
  /** The catalogue's own link, which the importer may or may not take. */
  url: string;
}

export interface AlbumGap {
  album: string;
  artist: string;
  cover: string | null;
  owned: number;
  total: number;
  missing: MissingTrack[];
}

/**
 * Which of an artist's records you own part of, nearly-complete first.
 *
 * Throws ServerError(404) on a server from before this shipped; the caller
 * says so plainly rather than showing an empty shelf that reads as "you have
 * everything".
 */
export async function fetchAlbumGaps(
  session: ServerSession,
  artist: string,
  signal?: AbortSignal,
): Promise<AlbumGap[]> {
  const reply = await request<{ albums: AlbumGap[] }>(
    session.url,
    `/api/albums/gaps?artist=${encodeURIComponent(artist)}`,
    { token: session.token, signal },
  );
  return reply.albums ?? [];
}

export interface CatalogRelease {
  id: string;
  title: string;
  cover: string | null;
  year: string | null;
  trackCount: number | null;
  kind: string;
  url: string;
  /** As `SearchResult.importable`. A whole discography arrives from Deezer, so
   *  this is usually false - which is a fact about the Add button, not about
   *  whether the record belongs on the page. */
  importable: boolean;
}

/** One of an artist's best-known tracks, importable on its own. */
export interface CatalogTrack {
  id: string;
  title: string;
  cover: string | null;
  url: string;
  /** Seconds. */
  duration: number | null;
  /** As `SearchResult.importable`. */
  importable: boolean;
}

/** An artist's profile and discography, from `GET /api/artist`. */
export interface CatalogArtist {
  id: string;
  name: string;
  picture: string | null;
  url: string;
  source: string;
  /** Follower count, as the catalogue reports it. */
  fans: number | null;
  albumCount: number | null;
  albums: CatalogRelease[];
  singles: CatalogRelease[];
  top: CatalogTrack[];
  related: { id: string; name: string; picture: string | null }[];
}

/**
 * One catalogue artist, opened from a search row. The name rides along because
 * a Spotify row carries no Deezer id and the server resolves it by name.
 */
export async function fetchCatalogArtist(
  session: ServerSession,
  id: string,
  name: string,
  signal?: AbortSignal,
): Promise<CatalogArtist> {
  const reply = await request<{ artist: CatalogArtist }>(
    session.url,
    `/api/artist?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`,
    { token: session.token, signal },
  );
  return reply.artist;
}

/**
 * Logs one qualifying play. Fire-and-forget from the player: a listen that
 * fails to record is not worth interrupting.
 */
export function reportPlay(session: ServerSession, trackId: number): void {
  void request(session.url, '/api/plays', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ trackId }),
  }).catch(() => {});
}

// --- folder sync ------------------------------------------------------------

/** One local file's identity, as the sync precheck states it to the server. */
export interface SyncCheckEntry {
  title: string;
  artist: string;
  album: string;
  /** Seconds, when the tags said. */
  duration: number | null;
}

/**
 * Which of these tracks the server lacks, as indices into `entries`. Identity
 * is tags, not bytes - the same song already uploaded from another rip counts
 * as present. Throws ServerError 404 on a server from before the endpoint,
 * which callers must read as "sync unavailable", never "upload everything".
 */
export async function fetchMissingTracks(
  session: ServerSession,
  entries: SyncCheckEntry[],
): Promise<Set<number>> {
  const reply = await request<{ missing: number[] }>(session.url, '/api/library/missing', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({
      tracks: entries.map((e) => ({
        title: e.title,
        artist: e.artist,
        album: e.album,
        duration: e.duration ?? undefined,
      })),
    }),
  });
  return new Set(reply.missing);
}

// --- playlists --------------------------------------------------------------

/** A playlist as the server holds it: track ids, in order. */
export interface RemotePlaylist {
  id: number;
  name: string;
  updatedAt: number;
  tracks: number[];
}

export async function fetchRemotePlaylists(session: ServerSession): Promise<RemotePlaylist[]> {
  const reply = await request<{ playlists: RemotePlaylist[] }>(session.url, '/api/playlists', {
    token: session.token,
  });
  return reply.playlists;
}

export async function createRemotePlaylist(
  session: ServerSession,
  name: string,
  tracks: number[] = [],
): Promise<number> {
  const reply = await request<{ id: number }>(session.url, '/api/playlists', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ name, tracks }),
  });
  return reply.id;
}

export async function updateRemotePlaylist(
  session: ServerSession,
  id: number,
  patch: { name?: string; tracks?: number[] },
): Promise<void> {
  await request(session.url, `/api/playlists/${id}`, {
    method: 'PUT',
    token: session.token,
    body: JSON.stringify(patch),
  });
}

export async function deleteRemotePlaylist(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/playlists/${id}`, {
    method: 'DELETE',
    token: session.token,
  });
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

// --- the endless station -----------------------------------------------------

/**
 * The next handful for a station. Called again whenever the queue runs low,
 * which is what makes it endless: the server holds no cursor, so the client
 * passes what it already has (`exclude`) and gets something else back.
 */
export async function fetchRadio(
  session: ServerSession,
  opts: {
    /** Start from this track's feel. */
    seed?: number | null;
    /** -1 calmer .. 1 harder. */
    energy?: number;
    /** 0 deep cuts .. 1 favourites. */
    familiar?: number;
    n?: number;
    /** Track ids already queued, so a page never repeats the last one. */
    exclude?: readonly number[];
    /** Blend with another account on this server. */
    with?: number | null;
  } = {},
  signal?: AbortSignal,
): Promise<number[]> {
  const q = new URLSearchParams();
  if (opts.seed != null) q.set('seed', String(opts.seed));
  if (opts.energy !== undefined) q.set('energy', String(opts.energy));
  if (opts.familiar !== undefined) q.set('familiar', String(opts.familiar));
  if (opts.n !== undefined) q.set('n', String(opts.n));
  if (opts.with != null) q.set('with', String(opts.with));
  if (opts.exclude && opts.exclude.length > 0) {
    // The tail is what matters - the server only needs to avoid what is still
    // ahead, and a URL is not the place for a whole listening history.
    q.set('exclude', opts.exclude.slice(-120).join(','));
  }
  const reply = await request<{ tracks: number[] }>(session.url, `/api/radio?${q}`, {
    token: session.token,
    signal,
  });
  return reply.tracks ?? [];
}

/** One account on this server, for the household surfaces. */
export interface HouseholdPerson {
  id: number;
  username: string;
  me: boolean;
}

/** Who else is on this server. Any signed-in listener may ask - see the
 *  endpoint's own note on why this is not the admin-only user list. */
export async function fetchHousehold(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<HouseholdPerson[]> {
  const reply = await request<{ people: HouseholdPerson[] }>(session.url, '/api/household', {
    token: session.token,
    signal,
  });
  return reply.people ?? [];
}
