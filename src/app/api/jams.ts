import { request, type ServerSession } from './http.ts';

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
