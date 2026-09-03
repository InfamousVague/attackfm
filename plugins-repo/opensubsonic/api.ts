// The type comes from the source (a type is erased at build time and never
// reaches the host table); the VALUE side is imported through the host.
import type { ServerSession } from '../../src/app/server.ts';

/**
 * The hub's side of the Subsonic door, as this plugin sees it. Two halves,
 * and they are genuinely different things:
 *
 *   - the DOOR: this library answering /rest, so a Subsonic app (Symfonium,
 *     play:Sub, Amperfy, Feishin...) can play from here. Owner's switch, and
 *     one app password per member.
 *   - the REMOTE: another OpenSubsonic server this member reads, to bring
 *     playlists, albums and stars across.
 *
 * Nothing secret is ever read back: the app password is shown once when it is
 * minted, and the remote's password leaves this device and is never returned.
 */

async function hub<T>(session: ServerSession, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${session.url}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// --- the door ---------------------------------------------------------------

export interface DoorStatus {
  enabled: boolean;
  hasSecret: boolean;
  username: string;
  url: string | null;
}

export function fetchDoor(session: ServerSession): Promise<DoorStatus> {
  return hub<DoorStatus>(session, '/api/subsonic');
}

export function setDoor(session: ServerSession, enabled: boolean): Promise<{ enabled: boolean }> {
  return hub(session, '/api/subsonic/flag', { method: 'POST', body: JSON.stringify({ enabled }) });
}

/** Mint an app password. The only time it is ever legible. */
export function mintSecret(session: ServerSession): Promise<{ secret: string; username: string }> {
  return hub(session, '/api/subsonic/secret', { method: 'POST' });
}

export function revokeSecret(session: ServerSession): Promise<{ ok: boolean }> {
  return hub(session, '/api/subsonic/secret', { method: 'DELETE' });
}

// --- the remote -------------------------------------------------------------

export interface RemoteStatus {
  connected: boolean;
  url?: string;
  username?: string;
  serverType?: string;
  serverVersion?: string;
}

export interface RemotePlaylist {
  id: string;
  name: string;
  owner: string;
  songCount: number;
  haveByName: boolean;
}

export interface RemoteAlbum {
  id: string;
  name: string;
  artist: string;
  year: number | null;
  songCount: number;
}

export interface RemoteSong {
  id: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  have: boolean;
}

export interface ImportJob {
  id: string;
  title: string;
  state: 'queued' | 'running' | 'done';
  total: number;
  done: number;
  linked: number;
  downloaded: number;
  failed: number;
  current: string;
  error: string;
  playlists: { id: number; name: string; songs: number }[];
  starred: number;
  startedAt: number;
  log: string[];
}

export function fetchRemote(session: ServerSession): Promise<RemoteStatus> {
  return hub<RemoteStatus>(session, '/api/subsonic/remote');
}

export function connectRemote(
  session: ServerSession,
  body: { url: string; username: string; password: string },
): Promise<RemoteStatus> {
  return hub(session, '/api/subsonic/remote', { method: 'PUT', body: JSON.stringify(body) });
}

export function disconnectRemote(session: ServerSession): Promise<{ ok: boolean }> {
  return hub(session, '/api/subsonic/remote', { method: 'DELETE' });
}

export function remotePlaylists(session: ServerSession): Promise<{ playlists: RemotePlaylist[] }> {
  return hub(session, '/api/subsonic/remote/playlists');
}

export function remoteAlbums(session: ServerSession, offset = 0): Promise<{ albums: RemoteAlbum[]; offset: number }> {
  return hub(session, `/api/subsonic/remote/albums?offset=${offset}`);
}

export function remoteStarred(
  session: ServerSession,
): Promise<{ count: number; have: number; songs: RemoteSong[] }> {
  return hub(session, '/api/subsonic/remote/starred');
}

export function startImport(
  session: ServerSession,
  body: { playlists?: string[]; albums?: string[]; starred?: boolean },
): Promise<{ jobId: string }> {
  return hub(session, '/api/subsonic/remote/import', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchJobs(session: ServerSession): Promise<{ jobs: ImportJob[] }> {
  return hub(session, '/api/subsonic/remote/jobs');
}

export function exportPlaylist(
  session: ServerSession,
  playlistId: number,
): Promise<{ name: string; matched: number; missed: number; missing: string[]; replaced: boolean }> {
  return hub(session, '/api/subsonic/remote/export', {
    method: 'POST',
    body: JSON.stringify({ playlistId }),
  });
}
