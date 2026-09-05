import { request, type ServerSession, ServerError } from './http.ts';

// --- friends ---------------------------------------------------------------

export interface Friend {
  userId: number;
  username: string;
}

/** A pending ask, in whichever direction. `userId` is the OTHER person. */
export interface FriendRequest {
  id: number;
  userId: number;
  username: string;
}

export interface FriendsFeed {
  friends: Friend[];
  /** Asks aimed at you, waiting on your answer. */
  incoming: FriendRequest[];
  /** Asks you sent, waiting on theirs. */
  outgoing: FriendRequest[];
}

/** One person on this server, as the share sheet seats them. */
export interface Member {
  userId: number;
  username: string;
}

/**
 * Everyone on this server - the people a playlist can be shared with. An
 * older hub answers 404, and the caller falls back to friends-only.
 */
export async function fetchMembers(session: ServerSession): Promise<Member[] | null> {
  try {
    const out = await request<{ members?: Member[] }>(session.url, '/api/members', { token: session.token });
    return (out.members ?? []).filter((m) => typeof m.userId === 'number' && typeof m.username === 'string');
  } catch (e) {
    if (e instanceof ServerError && e.status === 404) return null;
    throw e;
  }
}

export async function fetchFriends(session: ServerSession): Promise<FriendsFeed> {
  const out = await request<Partial<FriendsFeed>>(session.url, '/api/friends', {
    token: session.token,
  });
  return { friends: out.friends ?? [], incoming: out.incoming ?? [], outgoing: out.outgoing ?? [] };
}

/** Asks someone to be friends, by the name they signed up with. Resolves to
 *  whether it settled immediately - it does when they had already asked you. */
export async function sendFriendRequest(
  session: ServerSession,
  username: string,
): Promise<{ friends: boolean }> {
  const out = await request<{ friends?: boolean }>(session.url, '/api/friends/requests', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({ username }),
  });
  return { friends: out.friends === true };
}

export async function acceptFriendRequest(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/friends/requests/${id}/accept`, {
    token: session.token,
    method: 'POST',
  });
}

/** Turns down an ask aimed at you, or withdraws one you sent. */
export async function declineFriendRequest(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/friends/requests/${id}/decline`, {
    token: session.token,
    method: 'POST',
  });
}

export async function removeFriend(session: ServerSession, userId: number): Promise<void> {
  await request(session.url, `/api/friends/${userId}`, {
    token: session.token,
    method: 'DELETE',
  });
}

/**
 * Hand the hub this account's registry friends, by handle. The hub files a
 * request to each one who is a member here; crossed requests become
 * friendships. Older hubs 404 - swallowed, since a hub that cannot mirror
 * simply keeps an empty friend list as before.
 */
export async function mirrorFriendsToHub(
  session: ServerSession,
  handles: string[],
  /** The registry session: with it the hub verifies the list with attack.fm
   *  itself and settles every friendship at once, instead of filing requests
   *  that wait for the other person's app. */
  registryToken?: string,
): Promise<void> {
  try {
    await request(session.url, '/api/friends/mirror', {
      method: 'POST',
      token: session.token,
      body: JSON.stringify({ handles, registryToken }),
    });
  } catch {
    // See above.
  }
}
