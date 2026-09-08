import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../api/http.ts';
import { syncRegistryFriendsToHub } from './friendMirror.ts';

const { fetchFriends, mirrorFriendsToHub } = vi.hoisted(() => ({
  fetchFriends: vi.fn(),
  mirrorFriendsToHub: vi.fn(),
}));
vi.mock('../servers/registry.ts', () => ({ fetchFriends }));
vi.mock('../api/friends.ts', () => ({ mirrorFriendsToHub }));

const session: ServerSession = {
  url: 'https://home.example.com',
  token: 'tok',
  streamToken: 'stream',
  username: 'matt',
  isAdmin: false,
};

beforeEach(() => {
  fetchFriends.mockReset();
  mirrorFriendsToHub.mockReset();
  mirrorFriendsToHub.mockResolvedValue(undefined);
});

describe('syncRegistryFriendsToHub', () => {
  it('hands the hub the whole list NOW, with the registry token', async () => {
    /*
     * The window this closes: friendships live on the registry and reach a hub
     * on a ten-minute mirror, so befriending somebody and inviting them a
     * minute later found a hub that could see the member and not the
     * friendship. The token is what lets the hub ask attack.fm itself and
     * settle the pair on the spot rather than filing a request that waits for
     * the other person's app to open.
     */
    fetchFriends.mockResolvedValue({ friends: [{ handle: 'kayla' }, { handle: 'sam' }] });
    await expect(syncRegistryFriendsToHub(session, 'reg-token')).resolves.toBe(true);
    expect(mirrorFriendsToHub).toHaveBeenCalledWith(session, ['kayla', 'sam'], 'reg-token');
  });

  it('says NO when the registry lists nobody, and hands the hub nothing', async () => {
    /*
     * This false is load-bearing, and it is why the two refusals read
     * differently. The caller's shape is:
     *
     *     if (!synced) throw e;      // the hub's ORIGINAL words
     *     await inviteAgain();
     *
     * so a person who is simply not on this box keeps the hub's "that friend
     * is not on this server" instead of being told the server is still
     * catching up with a friends list that has nothing in it to catch up on.
     */
    fetchFriends.mockResolvedValue({ friends: [] });
    await expect(syncRegistryFriendsToHub(session, 'reg-token')).resolves.toBe(false);
    expect(mirrorFriendsToHub).not.toHaveBeenCalled();
  });

  it('says no when every handle the registry sent is blank', async () => {
    fetchFriends.mockResolvedValue({ friends: [{ handle: '' }] });
    await expect(syncRegistryFriendsToHub(session, 'reg-token')).resolves.toBe(false);
    expect(mirrorFriendsToHub).not.toHaveBeenCalled();
  });

  it('drops a blank handle out of a list that has real ones', async () => {
    fetchFriends.mockResolvedValue({ friends: [{ handle: 'kayla' }, { handle: '' }] });
    await expect(syncRegistryFriendsToHub(session, 'reg-token')).resolves.toBe(true);
    expect(mirrorFriendsToHub).toHaveBeenCalledWith(session, ['kayla'], 'reg-token');
  });

  it('rejects when the registry cannot be reached, so a caller reads it as "not synced"', async () => {
    // Every caller wraps this in `.catch(() => false)` - "we could not ask"
    // has to land on the same side as "there was nothing to hand over", or a
    // registry outage turns every refusal into the catching-up sentence.
    fetchFriends.mockRejectedValue(new Error('offline'));
    await expect(syncRegistryFriendsToHub(session, 'reg-token')).rejects.toThrow('offline');
    expect(mirrorFriendsToHub).not.toHaveBeenCalled();
  });
});
