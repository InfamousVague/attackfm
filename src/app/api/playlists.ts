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
  /** Songs filed into this list that the box does not own yet - the
   *  "plan to acquire" members, shown as arriving ghosts until they land.
   *  Absent on a server from before wants existed. */
  wants?: PlaylistWant[];
}

/** A song filed into a playlist that is not here yet: the playlist twin of a
 *  pending like. Identified by the same folded key the server settles on
 *  (`k = fold(artist)|titleKey(title)`), so a landed download can be matched
 *  to it. Dissolves into an ordinary track the moment its download lands. */
export interface PlaylistWant {
  k: string;
  title: string;
  artist: string;
  /** The catalogue link, when one was known when it was filed. '' otherwise. */
  url: string;
  createdAt: number;
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

// --- playlist wants (plan-to-acquire members) -------------------------------

/**
 * File a song this box does not own yet into a playlist, and start fetching it.
 * The server records the want, kicks off the download, and files the real track
 * into the list when it lands. `landed` is true when the song was already here
 * and joined the list at once (no want, no download).
 */
export async function addPlaylistWant(
  session: ServerSession,
  id: number,
  target: { artist: string; title: string; url?: string },
): Promise<{ landed: boolean; k: string }> {
  return request(session.url, `/api/playlists/${id}/wants`, {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ artist: target.artist, title: target.title, url: target.url ?? '' }),
  });
}

/** Withdraw a want before it has landed. */
export async function removePlaylistWant(
  session: ServerSession,
  id: number,
  k: string,
): Promise<void> {
  await request(session.url, `/api/playlists/${id}/wants/${encodeURIComponent(k)}`, {
    method: 'DELETE',
    token: session.token,
  });
}

/** Ask the box to file a want into its list NOW because its song has just
 *  landed in the library - the fast path the client takes rather than waiting
 *  for the server's own settle sweep. Returns whether it settled. */
export async function settlePlaylistWant(
  session: ServerSession,
  id: number,
  k: string,
): Promise<{ settled: boolean }> {
  return request(session.url, `/api/playlists/${id}/wants/${encodeURIComponent(k)}/settle`, {
    method: 'POST',
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
