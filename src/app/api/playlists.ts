import { request, type ServerSession } from './http.ts';

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
