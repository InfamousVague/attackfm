import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from './http.ts';
import {
  addToJamQueue,
  controlJam,
  fetchJams,
  inviteToJam,
  pushJamState,
  withdrawFromJamQueue,
} from './jams.ts';

/*
 * `request` is the seam. Everything in this file is the mapping between what
 * a hub says on the wire and what the deck is handed - which is precisely the
 * code that has to survive a hub older than the client talking to it.
 */
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./http.ts', () => ({ request }));

const session: ServerSession = {
  url: 'https://home.example.com',
  token: 'tok',
  streamToken: 'stream',
  username: 'matt',
  isAdmin: false,
};

/** What `request` was handed, decoded. */
function sent(call = 0) {
  const args = request.mock.calls[call] as [string, string, { body?: string; method?: string }];
  return {
    path: args[1],
    method: args[2].method,
    body: args[2].body ? (JSON.parse(args[2].body) as Record<string, unknown>) : undefined,
  };
}

beforeEach(() => {
  request.mockReset();
});

describe('fetchJams against a hub older than this client', () => {
  it('reads a reply with none of the newer fields as empty, and does not throw', async () => {
    // The oldest shape this route ever answered with. Every field the deck
    // reads has to have an answer here, because the alternative is a screen
    // that renders nothing at all.
    request.mockResolvedValue({ current: null, friends: [], invites: [] });
    const feed = await fetchJams(session);
    expect(feed).toEqual({
      current: null,
      friends: [],
      nearby: [],
      invites: [],
      commands: [],
      additions: [],
      additionsNext: [],
    });
  });

  it('reads an EMPTY reply the same way', async () => {
    request.mockResolvedValue({});
    await expect(fetchJams(session)).resolves.toEqual({
      current: null,
      friends: [],
      nearby: [],
      invites: [],
      commands: [],
      additions: [],
      additionsNext: [],
    });
  });

  it('reads a null field as empty', async () => {
    request.mockResolvedValue({ nearby: null, commands: null, additions: null, additionsNext: null });
    const feed = await fetchJams(session);
    expect(feed.nearby).toEqual([]);
    expect(feed.commands).toEqual([]);
    expect(feed.additions).toEqual([]);
    expect(feed.additionsNext).toEqual([]);
  });

  it('reads a field that is not a LIST as empty, rather than trying to walk it', async () => {
    /*
     * `?? []` is not enough here and the difference is the whole test: a
     * value that is merely present survives it and then meets `.map`, and
     * `nearby.map is not a function` inside a poll takes the entire groove
     * feed down - the room you are in, the rooms your friends are in, and
     * the invites - over a field the room list does not need.
     */
    request.mockResolvedValue({ nearby: 2, commands: 'soon', additions: { 1: 2 }, additionsNext: 7 });
    const feed = await fetchJams(session);
    expect(feed.nearby).toEqual([]);
    expect(feed.commands).toEqual([]);
    expect(feed.additions).toEqual([]);
    expect(feed.additionsNext).toEqual([]);
  });
});

describe('fetchJams shape mapping', () => {
  it('flags every room in `nearby`, whether or not the row said so', async () => {
    // The list IS the flag: a room the hub put there is on this network.
    request.mockResolvedValue({ nearby: [{ id: 'a' }, { id: 'b', nearby: false }] });
    const feed = await fetchJams(session);
    expect(feed.nearby.map((r) => r.nearby)).toEqual([true, true]);
  });

  it('takes only a literal true as nearby on a friend room', async () => {
    // `=== true`, not truthiness: a hub answering `nearby: 1` has not said yes.
    request.mockResolvedValue({ friends: [{ id: 'a', nearby: true }, { id: 'b', nearby: 1 }, { id: 'c' }] });
    const feed = await fetchJams(session);
    expect(feed.friends.map((r) => r.nearby)).toEqual([true, false, false]);
  });

  it('keeps the rest of a room row untouched', async () => {
    request.mockResolvedValue({ friends: [{ id: 'a', hostName: 'kayla', memberCount: 3 }] });
    const feed = await fetchJams(session);
    expect(feed.friends[0]).toMatchObject({ id: 'a', hostName: 'kayla', memberCount: 3 });
  });

  it('reads any invite that does not say "jam" as a listen-along', async () => {
    request.mockResolvedValue({
      invites: [{ from: 'a', kind: 'jam' }, { from: 'b', kind: 'along' }, { from: 'c' }, { from: 'd', kind: 'JAM' }],
    });
    const feed = await fetchJams(session);
    expect(feed.invites.map((i) => i.kind)).toEqual(['jam', 'along', 'along', 'along']);
  });

  it('drops a non-number out of the addition lists', async () => {
    request.mockResolvedValue({ additions: [1, '2', null, 3], additionsNext: [4, undefined, 5] });
    const feed = await fetchJams(session);
    expect(feed.additions).toEqual([1, 3]);
    expect(feed.additionsNext).toEqual([4, 5]);
  });

  it('asks the right door with the session token', async () => {
    request.mockResolvedValue({});
    await fetchJams(session);
    expect(request).toHaveBeenCalledWith(session.url, '/api/jams', { token: 'tok' });
  });
});

describe('pushJamState', () => {
  it('reads a beat reply with no lists as nothing to fold in', async () => {
    // An older hub appends everything and never mentions additionsNext.
    request.mockResolvedValue({});
    await expect(
      pushJamState(session, 'room7', { trackId: 1, positionMs: 0, playing: true }),
    ).resolves.toEqual({ additions: [], additionsNext: [], commands: [] });
  });

  it('keeps the two send lists apart, in the order the hub gave them', async () => {
    request.mockResolvedValue({ additions: [10, 11], additionsNext: [20, 21], commands: [{ action: 'pause', by: 'kayla', at: 5 }] });
    const reply = await pushJamState(session, 'room7', { trackId: 1, positionMs: 0, playing: true });
    expect(reply.additions).toEqual([10, 11]);
    expect(reply.additionsNext).toEqual([20, 21]);
    expect(reply.commands).toHaveLength(1);
  });

  it('reads a non-array list as empty', async () => {
    request.mockResolvedValue({ additions: 'nope', additionsNext: null });
    const reply = await pushJamState(session, 'room7', { trackId: null, positionMs: 0, playing: false });
    expect(reply.additions).toEqual([]);
    expect(reply.additionsNext).toEqual([]);
  });

  it('posts the state as given', async () => {
    request.mockResolvedValue({});
    await pushJamState(session, 'room7', { trackId: 42, positionMs: 1234, playing: true, queue: [1, 2] });
    expect(sent().path).toBe('/api/jams/room7/state');
    expect(sent().body).toEqual({ trackId: 42, positionMs: 1234, playing: true, queue: [1, 2] });
  });
});

describe('controlJam', () => {
  it('sends a position only for a seek', async () => {
    request.mockResolvedValue({ queued: 1 });
    await controlJam(session, 'room7', 'pause', 5000);
    expect(sent().body).toEqual({ action: 'pause' });
  });

  it('rounds a seek and never sends a negative one', async () => {
    request.mockResolvedValue({ queued: 1 });
    await controlJam(session, 'room7', 'seek', 1234.7);
    expect(sent().body).toEqual({ action: 'seek', positionMs: 1235 });

    request.mockClear();
    await controlJam(session, 'room7', 'seek', -50);
    expect(sent().body).toEqual({ action: 'seek', positionMs: 0 });

    request.mockClear();
    await controlJam(session, 'room7', 'seek');
    expect(sent().body).toEqual({ action: 'seek', positionMs: 0 });
  });

  it('counts this one when a hub does not say how many are waiting', async () => {
    request.mockResolvedValue({ ok: true });
    await expect(controlJam(session, 'room7', 'next')).resolves.toBe(1);
  });

  it('passes the hub s count through when it gives one', async () => {
    request.mockResolvedValue({ queued: 3 });
    await expect(controlJam(session, 'room7', 'next')).resolves.toBe(3);
  });
});

describe('addToJamQueue', () => {
  it('sends an older hub the exact request it has always seen', async () => {
    // The `next` key is only sent when asked: a hub that does not know it
    // would otherwise be handed a field it ignores, and the request would
    // stop being byte-identical to the one it was written against.
    request.mockResolvedValue({});
    await addToJamQueue(session, 'room7', 42);
    expect(sent().body).toEqual({ trackId: 42 });
    expect(Object.keys(sent().body ?? {})).not.toContain('next');
  });

  it('asks for play-next when asked', async () => {
    request.mockResolvedValue({});
    await addToJamQueue(session, 'room7', 42, true);
    expect(sent().body).toEqual({ trackId: 42, next: true });
  });

  it('withdraws by id', async () => {
    request.mockResolvedValue({});
    await withdrawFromJamQueue(session, 'room7', 42);
    expect(sent().path).toBe('/api/jams/room7/queue/42');
    expect(sent().method).toBe('DELETE');
  });
});

describe('inviteToJam', () => {
  it('carries the registry token when there is one, so the hub can verify a friendship it has not mirrored', async () => {
    request.mockResolvedValue({});
    await inviteToJam(session, 'kayla', 'jam', 'reg-token');
    expect(sent().body).toEqual({ to: 'kayla', kind: 'jam', registryToken: 'reg-token' });
  });

  it('omits the key entirely when there is no registry session', async () => {
    request.mockResolvedValue({});
    await inviteToJam(session, 'kayla');
    expect(sent().body).toEqual({ to: 'kayla', kind: 'along' });
    expect(Object.keys(sent().body ?? {})).not.toContain('registryToken');
  });
});
