import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from './http.ts';
import { fetchFriends, fetchMembers, mirrorFriendsToHub, sendFriendRequest } from './friends.ts';

const { request, ServerError } = vi.hoisted(() => {
  class FakeServerError extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return { request: vi.fn(), ServerError: FakeServerError };
});
vi.mock('./http.ts', () => ({ request, ServerError }));

const session: ServerSession = {
  url: 'https://home.example.com',
  token: 'tok',
  streamToken: 's',
  username: 'matt',
  isAdmin: false,
};

beforeEach(() => {
  request.mockReset();
});

describe('fetchMembers', () => {
  it('is the roster a playlist seat is offered from', async () => {
    request.mockResolvedValue({ members: [{ userId: 5, username: 'sam' }] });
    await expect(fetchMembers(session)).resolves.toEqual([{ userId: 5, username: 'sam' }]);
  });

  it('answers NULL for a hub too old to have a roster - which is not the same as an empty one', async () => {
    // The picker falls back to friends-only on null. An empty array would say
    // "this hub has nobody on it", which is a different and untrue sentence.
    request.mockRejectedValue(new ServerError(404, 'no such route'));
    await expect(fetchMembers(session)).resolves.toBeNull();
  });

  it('lets a real failure through rather than reading an outage as an old hub', async () => {
    request.mockRejectedValue(new ServerError(500, 'boom'));
    await expect(fetchMembers(session)).rejects.toThrow('boom');
  });

  it('reads a reply with no members as an empty roster', async () => {
    request.mockResolvedValue({});
    await expect(fetchMembers(session)).resolves.toEqual([]);
  });

  it('drops a row that is not a person', async () => {
    // A malformed row would render as an untappable ghost in the picker.
    request.mockResolvedValue({
      members: [{ userId: 5, username: 'sam' }, { userId: '6', username: 'ana' }, { userId: 7 }, {}],
    });
    await expect(fetchMembers(session)).resolves.toEqual([{ userId: 5, username: 'sam' }]);
  });
});

describe('fetchFriends', () => {
  it('reads a hub that sends none of the three lists as three empty ones', async () => {
    request.mockResolvedValue({});
    await expect(fetchFriends(session)).resolves.toEqual({ friends: [], incoming: [], outgoing: [] });
  });
});

describe('sendFriendRequest', () => {
  it('says it settled only when the hub says exactly true', async () => {
    request.mockResolvedValue({ friends: true });
    await expect(sendFriendRequest(session, 'kayla')).resolves.toEqual({ friends: true });
    request.mockResolvedValue({});
    await expect(sendFriendRequest(session, 'kayla')).resolves.toEqual({ friends: false });
  });
});

describe('mirrorFriendsToHub', () => {
  it('hands over the handles and the registry token', async () => {
    request.mockResolvedValue({});
    await mirrorFriendsToHub(session, ['kayla', 'sam'], 'reg-token');
    const [, path, init] = request.mock.calls[0] as [string, string, { body: string }];
    expect(path).toBe('/api/friends/mirror');
    expect(JSON.parse(init.body)).toEqual({ handles: ['kayla', 'sam'], registryToken: 'reg-token' });
  });

  it('swallows a hub that cannot mirror at all', async () => {
    // A hub that 404s here simply keeps the empty friend list it always had;
    // the caller must not be handed an error it would have to explain.
    request.mockRejectedValue(new ServerError(404, 'no such route'));
    await expect(mirrorFriendsToHub(session, ['kayla'])).resolves.toBeUndefined();
  });
});
