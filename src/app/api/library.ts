import type { Track } from '../core/tauri.ts';
import { request, ServerError, type ServerSession } from './http.ts';
import { loadCachedIndex, saveCachedIndex } from './libraryCache.ts';

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
