/**
 * The count the Profile seat wears.
 *
 * `profileAttention.ts` makes three promises: the lanes ADD UP and one
 * reader's word never overwrites another's; a reader publishing zero at its
 * own sign-out takes only its share away; and the share arithmetic is the
 * page's - one per unanswered sender, one per song from an answered one,
 * nothing for a refused one. Each is a way the badge would lie if broken.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Share } from '../servers/registry.ts';
import {
  profileAttention,
  publishProfileAttention,
  shareAttentionOf,
  useProfileAttention,
} from './profileAttention.ts';

// The store is module state, so every test starts from what the last one left
// unless each lane is put back to nothing - which is also exactly the verb a
// sign-out uses, so nothing here reaches past the public surface.
afterEach(() => {
  publishProfileAttention('friendRequests', 0);
  publishProfileAttention('shares', 0);
  publishProfileAttention('grooveInvites', 0);
});

function share(over: Partial<Share>): Share {
  return {
    id: 1,
    fromId: 1,
    from: 'kim',
    artist: 'A',
    title: 'T',
    album: '',
    note: '',
    createdAt: 0,
    allowed: null,
    ...over,
  };
}

describe('the lanes add up', () => {
  it('sums every reader and lets each keep its own number', () => {
    publishProfileAttention('friendRequests', 2);
    publishProfileAttention('grooveInvites', 1);
    publishProfileAttention('shares', 3);
    expect(profileAttention()).toBe(6);
    // The friends poll saying 2 again is not the groove poll saying 0.
    publishProfileAttention('friendRequests', 2);
    expect(profileAttention()).toBe(6);
    publishProfileAttention('friendRequests', 1);
    expect(profileAttention()).toBe(5);
  });

  it('reads a nonsense count as nothing rather than as a badge', () => {
    publishProfileAttention('friendRequests', -3);
    publishProfileAttention('shares', Number.NaN);
    expect(profileAttention()).toBe(0);
    publishProfileAttention('grooveInvites', 2.9);
    expect(profileAttention()).toBe(2);
  });
});

describe('a sign-out takes only its own lane away', () => {
  it('leaves what the other session is still waiting on', () => {
    // Friends and shares follow the registry; groove asks follow the hub.
    publishProfileAttention('friendRequests', 1);
    publishProfileAttention('shares', 1);
    publishProfileAttention('grooveInvites', 1);
    // The registry readers, signed out: FriendNotices and ShareNotices each
    // publish zero where they take their bell rows away.
    publishProfileAttention('friendRequests', 0);
    publishProfileAttention('shares', 0);
    expect(profileAttention()).toBe(1);
    // And the hub's own reader, when that session goes.
    publishProfileAttention('grooveInvites', 0);
    expect(profileAttention()).toBe(0);
  });
});

describe('the hook', () => {
  it('follows publishes and stays quiet for a repeat', () => {
    const { result } = renderHook(() => useProfileAttention());
    expect(result.current).toBe(0);
    act(() => publishProfileAttention('friendRequests', 2));
    expect(result.current).toBe(2);
    act(() => publishProfileAttention('grooveInvites', 1));
    expect(result.current).toBe(3);
    act(() => publishProfileAttention('friendRequests', 0));
    expect(result.current).toBe(1);
  });

  it('wakes a subscriber only when the total actually moves', () => {
    const renders = vi.fn();
    renderHook(() => {
      renders(useProfileAttention());
    });
    renders.mockClear();
    act(() => publishProfileAttention('shares', 4));
    expect(renders).toHaveBeenCalledTimes(1);
    // The poll saying the same thing a minute later is not news.
    act(() => publishProfileAttention('shares', 4));
    expect(renders).toHaveBeenCalledTimes(1);
  });
});

describe('what a share inbox is worth', () => {
  it('counts one per sender still to be answered about, one per song from one already allowed', () => {
    const inbox: Share[] = [
      // Two songs from someone never answered about: ONE question, about them.
      share({ id: 1, from: 'ari', allowed: null }),
      share({ id: 2, from: 'ari', allowed: null }),
      // A second unanswered sender.
      share({ id: 3, from: 'bea', allowed: null }),
      // Songs from someone you take songs from: each its own card.
      share({ id: 4, from: 'kim', allowed: true }),
      share({ id: 5, from: 'kim', allowed: true }),
      // Songs from someone you refused are not on the page at all.
      share({ id: 6, from: 'dax', allowed: false }),
    ];
    expect(shareAttentionOf(inbox)).toBe(4);
    expect(shareAttentionOf([])).toBe(0);
  });
});
