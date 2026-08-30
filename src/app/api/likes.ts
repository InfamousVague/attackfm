import { request, type ServerSession } from './http.ts';

/** A heart promised on Discover, still waiting on its download. */
export interface PendingLike {
  k: string;
  title: string;
  artist: string;
  createdAt: number;
}

/**
 * Like a song that is not here yet: the server favourites it at once when a
 * matching track already exists (`landed`), and otherwise remembers the
 * promise - the collector's sweep keeps it the moment the download arrives.
 */
export async function addPendingLike(
  session: ServerSession,
  artist: string,
  title: string,
): Promise<{ landed: boolean; k: string }> {
  return request(session.url, '/api/likes/pending', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ artist, title }),
  });
}

export async function fetchPendingLikes(session: ServerSession): Promise<PendingLike[]> {
  const out = await request<{ pending?: PendingLike[] }>(session.url, '/api/likes/pending', {
    token: session.token,
  });
  return out.pending ?? [];
}

export async function removePendingLike(session: ServerSession, k: string): Promise<void> {
  await request(session.url, '/api/likes/pending/remove', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ k }),
  });
}
