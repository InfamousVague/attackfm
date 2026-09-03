import { request, type ServerSession } from './http.ts';

// --- jams ------------------------------------------------------------------

/** A live listening room. `positionMs` arrives already carried forward to the
 *  moment it was read, so a follower can seek straight to it. */
export interface JamPerson {
  id: number;
  name: string;
  joinedAt: number;
  seenAt: number;
  host: boolean;
}

export interface JamEvent {
  at: number;
  /** joined | left | host (the room changed hands to `who`). */
  kind: string;
  who: string;
}

export interface Jam {
  id: string;
  hostId: number;
  hostName: string;
  members: string[];
  /** The room's people with their standing - absent from an older hub. */
  people?: JamPerson[];
  memberCount: number;
  trackId: number | null;
  /** What is on, by name, for a member whose library lacks it. */
  trackTitle?: string;
  trackArtist?: string;
  positionMs: number;
  playing: boolean;
  queue: number[];
  /** Who asked for a track, by track id: "added by Kayla" on the row. */
  addedBy?: Record<string, string>;
  updatedAt: number;
  /** The host's beat has stopped arriving; the room is about to change hands. */
  hostQuiet?: boolean;
  events?: JamEvent[];
  createdAt?: number;
  /** The hub's clock when this was read. */
  now?: number;
  /** This device's clock when this arrived - stamped by the provider, so a
   *  follower can add the time since without any cross-machine skew. */
  receivedAt?: number;
}

/** A friend has asked you into a room. `kind` is the direction:
 *  - 'along': they want to listen along with what YOU are playing, so accepting
 *    makes your player the room's clock.
 *  - 'jam': they are hosting and want you to come join THEIR room. */
export interface JamInvite {
  from: string;
  kind: 'along' | 'jam';
  at: number;
}

export interface JamsFeed {
  /** The jam you are in, if any - hosting or following. */
  current: Jam | null;
  /** Jams your friends are hosting that you could join. */
  friends: Jam[];
  /** People asking to listen along with you, waiting to be answered. */
  invites: JamInvite[];
}

export async function fetchJams(session: ServerSession): Promise<JamsFeed> {
  const out = await request<Partial<JamsFeed>>(session.url, '/api/jams', { token: session.token });
  return {
    current: out.current ?? null,
    friends: out.friends ?? [],
    invites: (out.invites ?? []).map((i) => ({ ...i, kind: i.kind === 'jam' ? 'jam' : 'along' })),
  };
}

/** Ask a friend into a room. `along` (the default) asks a friend who is playing
 *  to let you listen along, hosted by them; `jam` asks an online friend to come
 *  join the room you host. Their client sees the ask and can accept. */
export async function inviteToJam(
  session: ServerSession,
  to: string,
  kind: 'along' | 'jam' = 'along',
): Promise<void> {
  await request(session.url, '/api/jams/invite', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ to, kind }),
  });
}

/** Say yes to a listen-along ask: you host the room, they are dropped in. */
export async function acceptJamInvite(session: ServerSession, from: string): Promise<Jam> {
  return request<Jam>(session.url, '/api/jams/invite/accept', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ from }),
  });
}

/** Let a listen-along ask go. The asker simply never sees a room appear. */
export async function declineJamInvite(session: ServerSession, from: string): Promise<void> {
  await request(session.url, '/api/jams/invite/decline', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ from }),
  });
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

/** The host closes the room for everyone. Leaving hands it on instead. */
export async function endJam(session: ServerSession, id: string): Promise<void> {
  await request(session.url, `/api/jams/${id}/end`, { token: session.token, method: 'POST' });
}

/** The host's clock, posted as it plays. Members read it and follow. The reply
 *  hands back any track ids members have asked to add since the last beat, for
 *  the host to fold into its own queue. */
export async function pushJamState(
  session: ServerSession,
  id: string,
  state: {
    trackId: number | null;
    trackTitle?: string;
    trackArtist?: string;
    positionMs: number;
    playing: boolean;
    queue?: number[];
    deviceId?: string;
  },
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
