/**
 * Every wire call the toolbox makes, in one place. The transport is the same
 * pattern the importer plugin uses - session.url + the bearer token from
 * useServerSession - with one addition: a 404 becomes MissingEndpointError,
 * because these endpoints are newer than many home servers and each tool
 * answers "not there yet" with a quiet note instead of a red error.
 *
 * The types mirror the server contract exactly; RemoteTrack is imported
 * type-only from the app source so the row shape can never drift from what
 * /api/library actually sends.
 */
import { useCallback, useEffect, useState } from 'react';
import type { RemoteTrack, ServerSession } from '../../src/app/server.ts';

export type { RemoteTrack, ServerSession };

/** The server answered 404: it predates this tool's endpoints. */
export class MissingEndpointError extends Error {
  constructor(path: string) {
    super(`endpoint missing: ${path}`);
    this.name = 'MissingEndpointError';
  }
}

/** The one sentence every tool shows when its endpoint is not there. */
export function missingNote(tool: string): string {
  return `Your home server doesn't have this tool yet - update it to use ${tool}.`;
}

async function serverFetch(
  session: ServerSession,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${session.url}${path}`, { ...init, headers });
  if (response.status === 404) throw new MissingEndpointError(path);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return response;
}

export async function serverRequest<T>(
  session: ServerSession,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await serverFetch(session, path, init);
  return (await response.json()) as T;
}

/** For the export endpoints, whose reply is a file rather than JSON. */
export async function serverBlob(session: ServerSession, path: string): Promise<Blob> {
  const response = await serverFetch(session, path);
  return response.blob();
}

/**
 * Hands a fetched blob to the browser as a download. The export endpoints
 * need the auth header, so a plain <a href> to them cannot work - the blob
 * comes down through fetch and leaves through an object URL instead.
 */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoking immediately races the click in some engines; a lazy revoke is
  // invisible and keeps the download alive.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

// --- the library, as the server's own rows ---------------------------------
//
// useLibrary() hands out the app's Track shape, which drops albumArtist, year
// and discNo on the floor - fields the art fixer and metadata doctor live on.
// So the toolbox reads /api/library itself, the same paged delta walk the
// sync runs, and works on RemoteTrack rows throughout.

interface LibraryDeltaPage {
  rev: number;
  more: boolean;
  tracks: RemoteTrack[];
  removed: number[];
}

export async function fetchAllRows(session: ServerSession): Promise<RemoteTrack[]> {
  const byId = new Map<number, RemoteTrack>();
  let since = 0;
  // The same page cap the app's sync uses, so a confused server cannot spin
  // this loop forever.
  for (let page = 0; page < 200; page += 1) {
    const delta = await serverRequest<LibraryDeltaPage>(session, `/api/library?since=${since}`);
    for (const track of delta.tracks) byId.set(track.id, track);
    for (const id of delta.removed) byId.delete(id);
    since = delta.rev;
    if (!delta.more) break;
  }
  return [...byId.values()];
}

export interface LibraryRows {
  /** Null while the first fetch is in flight; the rows after. */
  rows: RemoteTrack[] | null;
  error: string | null;
  reload: () => void;
  /** Local reconciliation after a write, so the UI reflects the server's
   *  reply without a full re-walk - the delta sync will confirm it anyway. */
  patch: (updater: (rows: RemoteTrack[]) => RemoteTrack[]) => void;
}

export function useLibraryRows(session: ServerSession): LibraryRows {
  const [rows, setRows] = useState<RemoteTrack[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let stale = false;
    setRows(null);
    setError(null);
    fetchAllRows(session)
      .then((all) => {
        if (!stale) setRows(all);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setError(e instanceof Error ? e.message : String(e));
        setRows([]);
      });
    return () => {
      stale = true;
    };
    // The token stands in for the session: reconnecting mints a new one.
  }, [session.url, session.token, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const patch = useCallback(
    (updater: (rows: RemoteTrack[]) => RemoteTrack[]) =>
      setRows((prev) => (prev ? updater(prev) : prev)),
    [],
  );
  return { rows, error, reload, patch };
}

/** A cover URL for a row's art id, at the server's thumb/card variants. */
export function rowArtUrl(session: ServerSession, artId: string, size: 160 | 640 = 160): string {
  return `${session.url}/api/art/${encodeURIComponent(artId)}?t=${encodeURIComponent(session.streamToken)}&size=${size}`;
}

// --- albums, grouped the way the art endpoints key them --------------------

export interface AlbumGroup {
  album: string;
  /** Falls back to the track artist: files without an album-artist tag are
   *  keyed by the server the same way. */
  albumArtist: string;
  tracks: RemoteTrack[];
  /** The first cover any member carries, or null when the album has none. */
  artId: string | null;
  bytes: number;
}

export function groupAlbums(rows: RemoteTrack[]): AlbumGroup[] {
  const order: string[] = [];
  const byKey = new Map<string, AlbumGroup>();
  for (const row of rows) {
    const album = row.album || 'Unknown album';
    const albumArtist = row.albumArtist || row.artist || 'Unknown artist';
    const key = `${album.toLowerCase()}\u0000${albumArtist.toLowerCase()}`;
    let group = byKey.get(key);
    if (!group) {
      group = { album, albumArtist, tracks: [], artId: null, bytes: 0 };
      byKey.set(key, group);
      order.push(key);
    }
    group.tracks.push(row);
    group.bytes += row.sizeBytes ?? 0;
    if (!group.artId && row.artId) group.artId = row.artId;
  }
  return order.map((key) => byKey.get(key)!);
}

// --- the tool endpoints, one thin function each ----------------------------

export interface TagPatch {
  title?: string;
  artist?: string;
  albumArtist?: string;
  album?: string;
  genre?: string;
  year?: number | null;
  trackNo?: number | null;
  discNo?: number | null;
}

/** Writes the given fields into the file's tags; the reply is the re-read row. */
export async function writeTags(
  session: ServerSession,
  trackId: number,
  patch: TagPatch,
): Promise<RemoteTrack> {
  const reply = await serverRequest<{ track: RemoteTrack }>(session, `/api/tracks/${trackId}/tags`, {
    method: 'POST',
    body: JSON.stringify(patch),
  });
  return reply.track;
}

export interface ArtCandidate {
  url: string;
  source: 'itunes' | 'deezer' | 'caa';
  width?: number;
  height?: number;
}

export async function fetchArtCandidates(
  session: ServerSession,
  artist: string,
  album: string,
): Promise<ArtCandidate[]> {
  const query = `artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`;
  const reply = await serverRequest<{ candidates: ArtCandidate[] }>(
    session,
    `/api/art/candidates?${query}`,
  );
  return reply.candidates;
}

/** Embeds the image at `url` into every file of the album. Admin-only. */
export async function applyAlbumArt(
  session: ServerSession,
  album: string,
  albumArtist: string,
  url: string,
): Promise<{ updated: number; artId: string | null }> {
  return serverRequest(session, '/api/album-art', {
    method: 'POST',
    body: JSON.stringify({ album, albumArtist, url }),
  });
}

export interface DuplicateCluster {
  tracks: RemoteTrack[];
}

export async function fetchDuplicates(session: ServerSession): Promise<DuplicateCluster[]> {
  const reply = await serverRequest<{ clusters: DuplicateCluster[] }>(
    session,
    '/api/library/duplicates',
  );
  return reply.clusters;
}

/** Re-points references and moves the dropped files to trash. Admin-only. */
export async function resolveDuplicates(
  session: ServerSession,
  keep: number,
  drop: number[],
): Promise<{ ok: true; dropped: number }> {
  return serverRequest(session, '/api/library/duplicates/resolve', {
    method: 'POST',
    body: JSON.stringify({ keep, drop }),
  });
}

export interface StorageReport {
  libraryBytes: number;
  trackCount: number;
  byArtist: { artist: string; bytes: number; tracks: number }[];
  byAlbum: { album: string; albumArtist: string; bytes: number; tracks: number }[];
  byCodec: { codec: string; bytes: number; tracks: number }[];
  artBytes: number;
  transcodeBytes: number;
  trashBytes: number;
  collector: { ledgerBytes: number; capBytes: number } | null;
  rarelyPlayed: { album: string; albumArtist: string; bytes: number; plays: number }[];
}

export async function fetchStorage(session: ServerSession): Promise<StorageReport> {
  return serverRequest<StorageReport>(session, '/api/storage');
}

/** A playlist as /api/playlists lists it: track ids, in order. */
export interface RemotePlaylist {
  id: number;
  name: string;
  updatedAt: number;
  tracks: number[];
}

export async function fetchPlaylists(session: ServerSession): Promise<RemotePlaylist[]> {
  const reply = await serverRequest<{ playlists: RemotePlaylist[] }>(session, '/api/playlists');
  return reply.playlists;
}

export interface ImportEntry {
  path?: string;
  title?: string;
  artist?: string;
}

export interface ImportReply {
  id: number;
  matched: number;
  missed: ImportEntry[];
}

export async function importPlaylist(
  session: ServerSession,
  name: string,
  entries: ImportEntry[],
): Promise<ImportReply> {
  return serverRequest<ImportReply>(session, '/api/playlists/import', {
    method: 'POST',
    body: JSON.stringify({ name, entries }),
  });
}
