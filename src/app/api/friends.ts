import { request, type ServerSession } from './http.ts';

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
