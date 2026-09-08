import { describe, expect, it } from 'vitest';
import { readFeedCache, writeFeedCache } from './feedCache.ts';
import type { ServerSession } from '../server.ts';

/** The last good answer for a feed, kept per server AND account so a shelf
 *  paints at full size on the first frame instead of popping in. */
const session = (over: Partial<ServerSession> = {}): ServerSession =>
  ({
    url: 'https://hub.example',
    username: 'matt',
    token: 't',
    ...over,
  }) as ServerSession;

describe('readFeedCache / writeFeedCache', () => {
  it('hands back what was written', () => {
    writeFeedCache(session(), 'home', { shelves: [1, 2, 3] });
    expect(readFeedCache(session(), 'home')).toEqual({ shelves: [1, 2, 3] });
  });

  it('keeps two ACCOUNTS on one server apart', () => {
    // Otherwise signing in as somebody else in the household paints their
    // feed for a round trip.
    writeFeedCache(session({ username: 'matt' }), 'home', 'mine');
    expect(readFeedCache(session({ username: 'kevin' }), 'home')).toBe(null);
  });

  it('keeps two SERVERS apart', () => {
    writeFeedCache(session({ url: 'https://a.example' }), 'home', 'a');
    expect(readFeedCache(session({ url: 'https://b.example' }), 'home')).toBe(null);
  });

  it('keeps two feeds apart', () => {
    writeFeedCache(session(), 'home', 'h');
    expect(readFeedCache(session(), 'curator')).toBe(null);
  });

  it('is null with no session - a signed-out app seeds from nothing', () => {
    expect(readFeedCache(null, 'home')).toBe(null);
    // And writing with none must not throw or leave a stray key behind.
    const before = localStorage.length;
    writeFeedCache(null, 'home', { a: 1 });
    expect(localStorage.length).toBe(before);
  });

  it('reads a torn entry as absent rather than throwing', () => {
    // "A cache that fails to parse is simply absent, and the launch behaves
    // like the first one: skeletons, then truth."
    writeFeedCache(session(), 'home', { a: 1 });
    const key = Object.keys(localStorage).find((k) => k.includes('|home'))!;
    localStorage.setItem(key, '{not json');
    expect(readFeedCache(session(), 'home')).toBe(null);
  });

  it('survives a write that storage refuses', () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException('QuotaExceededError');
    };
    try {
      expect(() => writeFeedCache(session(), 'home', { a: 1 })).not.toThrow();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
