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

/** A member's word on the room's transport, waiting for the host's player
 *  to pick it up. Queued on the hub by any member (see `controlJam`), drained
 *  into the host's beat reply oldest first. */
export type JamControlAction = 'play' | 'pause' | 'toggle' | 'next' | 'prev' | 'seek';

export interface JamCommand {
  action: JamControlAction;
  /** Only for 'seek': where to, in ms. */
  positionMs?: number;
  /** Who asked, by name. */
  by: string;
  /** Hub ms. */
  at: number;
}

/** A member's add the host has not folded in yet. */
export interface JamPending {
  trackId: number;
  /** Who asked, by name. */
  by: string;
  /** Hub ms. */
  at: number;
  /** Asked to PLAY NEXT - right after the song on - rather than to join the
   *  end of the line. Absent from an older hub, which is read as false. */
  next?: boolean;
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
  /** Songs members have asked for that the host's player has not folded in
   *  yet - shown at once, ahead of the host's own line. Absent from an older
   *  hub, which is read as none. */
  pending?: JamPending[];
  /** The hub's clock when the host's player last reported. Absent from an
   *  older hub. Compared against `now` (the same clock) to say "waiting for
   *  the host's player" when it has been quiet too long. */
  hostSeenAt?: number;
  /** Transport commands members have sent that the host's player has not
   *  drained yet - a follower shows "sent" until the next beat clears it.
   *  Absent from an older hub, which is read as none. */
  controls?: number;
  /** The host's own poll drains the queued commands when its player has
   *  gone quiet (exactly like additions); they ride here for it. */
  commands?: JamCommand[];
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
  /** The host is on THIS caller's network - the hub compared the addresses
   *  it saw them both arrive from (the same one, or the same private /24).
   *  The addresses themselves never leave the hub. Absent from an older hub,
   *  which is read as false. */
  nearby?: boolean;
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
  /** Rooms you are NOT in whose host is on your network - a friend's or
   *  not (a hub is already a circle: "someone on the same network" is the
   *  whole test). Each is flagged `nearby: true`. A friend's room can stand
   *  in both lists. Absent from an older hub, which is read as none. */
  nearby: Jam[];
  /** People asking to listen along with you, waiting to be answered. */
  invites: JamInvite[];
  /** The members' transport presses the hub handed THIS poll - only to the
   *  host, and only while the host's clock has gone quiet (a beating host
   *  gets them in its beat reply instead). Top-level on the wire, beside
   *  `additions`; absent from an older hub. */
  commands: JamCommand[];
}

export async function fetchJams(session: ServerSession): Promise<JamsFeed> {
  const out = await request<Partial<JamsFeed>>(session.url, '/api/jams', { token: session.token });
  return {
    current: out.current ?? null,
    friends: (out.friends ?? []).map((r) => ({ ...r, nearby: r.nearby === true })),
    // The list IS the flag: a room the hub put here is on this network,
    // whether or not it remembered to say so on the row.
    nearby: (Array.isArray(out.nearby) ? out.nearby : []).map((r) => ({ ...r, nearby: true })),
    invites: (out.invites ?? []).map((i) => ({ ...i, kind: i.kind === 'jam' ? 'jam' : 'along' })),
    commands: Array.isArray(out.commands) ? out.commands : [],
  };
}

/** Ask a friend into a room. `along` (the default) asks a friend who is playing
 *  to let you listen along, hosted by them; `jam` asks an online friend to come
 *  join the room you host. Their client sees the ask and can accept. */
export async function inviteToJam(
  session: ServerSession,
  to: string,
  kind: 'along' | 'jam' = 'along',
  /** The registry session: with it the hub can verify a friendship it has
   *  not mirrored yet and befriend the pair on the spot. */
  registryToken?: string,
): Promise<void> {
  await request(session.url, '/api/jams/invite', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify(registryToken ? { to, kind, registryToken } : { to, kind }),
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

/** What the host's beat brings back: the adds to fold in - the play-next
 *  sends apart from the appends, each oldest first - and the members'
 *  transport commands to apply, oldest first. */
export interface JamBeatReply {
  /** Sends for the END of the line. */
  additions: number[];
  /** Sends for right AFTER the song on, in the order they were asked (the
   *  first asker's song plays first). A send never stands in both lists.
   *  Empty from an older hub, which appends everything. */
  additionsNext: number[];
  commands: JamCommand[];
}

/** The host's clock, posted as it plays. Members read it and follow. The reply
 *  hands back any track ids members have asked to add since the last beat, for
 *  the host to fold into its own queue - and the transport commands members
 *  have sent since, drained, for the host's player to apply in order. */
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
): Promise<JamBeatReply> {
  const out = await request<{ additions?: number[]; additionsNext?: number[]; commands?: JamCommand[] }>(
    session.url,
    `/api/jams/${id}/state`,
    {
      token: session.token,
      method: 'POST',
      body: JSON.stringify(state),
    },
  );
  return {
    additions: Array.isArray(out.additions) ? out.additions : [],
    additionsNext: Array.isArray(out.additionsNext) ? out.additionsNext : [],
    commands: out.commands ?? [],
  };
}

/**
 * A member's hand on the room's transport. Any member may (the host too,
 * though its own deck answers directly and never needs to post): the hub
 * queues the command on the room - at most twenty, anything older than
 * fifteen seconds dropped - and the host's next beat drains it. Resolves
 * with how many are waiting, this one included. 403 for a non-member, 404
 * for a room that has ended, 400 for a seek without a position.
 */
export async function controlJam(
  session: ServerSession,
  id: string,
  action: JamControlAction,
  positionMs?: number,
): Promise<number> {
  const out = await request<{ ok?: boolean; queued?: number }>(session.url, `/api/jams/${id}/control`, {
    token: session.token,
    method: 'POST',
    body: JSON.stringify(
      action === 'seek' ? { action, positionMs: Math.max(0, Math.round(positionMs ?? 0)) } : { action },
    ),
  });
  return out.queued ?? 1;
}

/** A member drops a track into the groove's queue; the host folds it in on
 *  its next beat, and until then it stands in the room's `pending`. With
 *  `next` it is asked for right after the song on rather than the end of the
 *  line - the hub remembers, and hands it back in the beat's `additionsNext`.
 *  The key is only sent when asked, so an older hub (which ignores it and
 *  appends) sees the exact request it always did. */
export async function addToJamQueue(
  session: ServerSession,
  id: string,
  trackId: number,
  next = false,
): Promise<void> {
  await request(session.url, `/api/jams/${id}/queue`, {
    token: session.token,
    method: 'POST',
    body: JSON.stringify(next ? { trackId, next: true } : { trackId }),
  });
}

/** Take back your own pending add before the host folds it in. An older hub
 *  has no such route and answers 404, which callers swallow - the host's next
 *  beat folds the song in regardless, exactly as before. */
export async function withdrawFromJamQueue(
  session: ServerSession,
  id: string,
  trackId: number,
): Promise<void> {
  await request(session.url, `/api/jams/${id}/queue/${trackId}`, {
    token: session.token,
    method: 'DELETE',
  });
}
