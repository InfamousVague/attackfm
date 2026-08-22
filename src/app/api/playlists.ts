import { request, type ServerSession } from './http.ts';

// --- playlists --------------------------------------------------------------

/** A playlist as the server holds it: track ids, in order.
 *
 * The decoration fields are optional because a server from before they existed
 * simply does not send them - and `undefined` versus `''` is how the provider
 * tells "this server has no idea what a description is" from "no description".
 * The first falls back to the device's own meta store; the second is an answer.
 */
export interface RemotePlaylist {
  id: number;
  name: string;
  updatedAt: number;
  tracks: number[];
  description?: string;
  folder?: string;
  /** The cover's filename on the server, or '' when none is set. */
  cover?: string;
  /** Separate this list's songs ahead of being asked. Absent on a server
   *  from before per-list separation, which reads as "not opted in". */
  autoStem?: boolean;
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
  patch: {
    name?: string;
    tracks?: number[];
    description?: string;
    folder?: string;
    autoStem?: boolean;
  },
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

/**
 * The address of a playlist's cover, display-ready.
 *
 * Carries the stream token the way art and canvas URLs do, because an
 * `<img src>` cannot send an Authorization header. `v` is the playlist's
 * updatedAt: the filename does not change when a JPEG replaces a JPEG, and
 * without a version in the URL every device that had seen the old picture
 * would keep it.
 */
export function playlistCoverUrl(
  session: ServerSession,
  id: number,
  updatedAt: number,
): string {
  return `${session.url}/api/playlists/${id}/cover?t=${encodeURIComponent(session.streamToken)}&v=${updatedAt}`;
}

/** Replace a playlist's cover with an image the user picked. */
export async function uploadPlaylistCover(
  session: ServerSession,
  id: number,
  image: Blob,
): Promise<void> {
  // Raw bytes, not multipart: the server sniffs the format from the magic
  // number, so the body is the image and nothing else.
  const res = await fetch(`${session.url}/api/playlists/${id}/cover`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.token}` },
    body: image,
  });
  if (!res.ok) {
    const why = await res.text().catch(() => '');
    throw new Error(why || `the server refused the cover (${res.status})`);
  }
}

/** Drop a playlist's cover, returning its tile to the song mosaic. */
export async function removePlaylistCover(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/playlists/${id}/cover`, {
    method: 'DELETE',
    token: session.token,
  });
}
