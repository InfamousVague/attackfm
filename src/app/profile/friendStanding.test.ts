import { describe, expect, it } from 'vitest';
import { activeFriends, rankOf, songIsFresh, standingOf, SONG_FRESH_MS } from './friendStanding.ts';
import type { RegistryFriend } from '../servers/registry.ts';

/**
 * Who the hero is allowed to be about, and in what order.
 *
 * Every failure here is a silent one. A stale `nowPlaying` announces a song
 * somebody finished before dinner; a conflated `online || playing` titles the
 * card after a friend who has merely opened the app; a ranking with an
 * incomplete tie-break reorders between two polls and moves a button out from
 * under a finger. None of it throws, and none of it is visible in a rendered
 * card unless you already know which friend should have been there.
 */

const NOW = Date.UTC(2026, 8, 6, 20, 0, 0);

/** A friend with nothing going on, to be spoiled by each test in turn. */
function friend(over: Partial<RegistryFriend> = {}): RegistryFriend {
  return {
    id: 1,
    handle: 'kim',
    serverUrl: 'https://here.example',
    seenAt: Math.floor(NOW / 1000),
    songs: 100,
    playlists: 2,
    artists: 40,
    ...over,
  };
}

/** A song heard by the registry `agoMs` ago. */
function song(playing: boolean, agoMs: number, over: Record<string, unknown> = {}) {
  return {
    title: 'Blue Bird',
    artist: 'Jon Hopkins',
    album: 'Singularity',
    playing,
    since: Math.floor((NOW - agoMs) / 1000),
    at: Math.floor((NOW - agoMs) / 1000),
    ...over,
  };
}

const HERE = { sameHub: () => true };
const AWAY = { sameHub: () => false };

describe('songIsFresh', () => {
  it('believes a song the registry heard about a minute ago', () => {
    expect(songIsFresh(friend({ nowPlaying: song(true, 60_000) }), NOW)).toBe(true);
  });

  it('stops believing one past the bound', () => {
    expect(songIsFresh(friend({ nowPlaying: song(true, SONG_FRESH_MS + 1000) }), NOW)).toBe(false);
  });

  // A phone that loses signal mid-song leaves `playing: true` sitting in the
  // registry for good. Without the bound the hero would still be announcing
  // it at midnight, which is the whole reason this function exists.
  it('refuses a song from a phone that went into a tunnel an hour ago', () => {
    expect(songIsFresh(friend({ nowPlaying: song(true, 3_600_000) }), NOW)).toBe(false);
  });

  // Two machines disagreeing about the time is common; a stamp from the future
  // must read as unusable rather than as eternally fresh.
  it('refuses a stamp from the future rather than trusting it forever', () => {
    expect(songIsFresh(friend({ nowPlaying: song(true, -60_000) }), NOW)).toBe(false);
  });
});

describe('standingOf', () => {
  it('says playing for a fresh song that is playing', () => {
    expect(standingOf(friend({ nowPlaying: song(true, 30_000) }), NOW)).toBe('playing');
  });

  it('says paused for a fresh song that is not', () => {
    expect(standingOf(friend({ nowPlaying: song(false, 30_000) }), NOW)).toBe('paused');
  });

  // The distinction the app did not make. Being awake is not news, and a card
  // that says "listening" about somebody who is not is a lie with a name on it.
  it('says here, not playing, for an online friend behind a stale song', () => {
    const f = friend({ online: true, nowPlaying: song(true, SONG_FRESH_MS + 60_000) });
    expect(standingOf(f, NOW)).toBe('here');
  });

  it('says away for an offline friend behind a stale song', () => {
    const f = friend({ online: false, seenAt: Math.floor((NOW - 3_600_000) / 1000) });
    expect(standingOf(f, NOW)).toBe('away');
  });
});

describe('rankOf', () => {
  it('puts a room you can walk into above a song you can follow', () => {
    const f = friend();
    const room = rankOf(f, 'playing', { sameHub: () => true, hosting: () => true });
    const along = rankOf(f, 'playing', HERE);
    expect(room).toBeGreaterThan(along);
  });

  // Same-hub is where the verbs are: listen along and invite both need the
  // music to be reachable from here.
  it('puts a same-hub friend above a cross-hub one at the same standing', () => {
    expect(rankOf(friend(), 'playing', HERE)).toBeGreaterThan(rankOf(friend(), 'playing', AWAY));
  });

  it('gives an away friend nothing', () => {
    expect(rankOf(friend(), 'away', HERE)).toBe(0);
  });

  // A room on somebody else's server is not a room this device can enter, so
  // hosting must not outrank a same-hub friend who is actually playing.
  it('does not let a cross-hub room jump the queue', () => {
    const far = rankOf(friend(), 'playing', { sameHub: () => false, hosting: () => true });
    expect(far).toBeLessThan(rankOf(friend(), 'playing', HERE));
  });
});

describe('activeFriends', () => {
  it('leaves away friends out entirely', () => {
    const cast = activeFriends(
      [friend({ id: 1, handle: 'kim', online: true }), friend({ id: 2, handle: 'ana', online: false, seenAt: 0 })],
      HERE,
      NOW,
    );
    expect(cast.map((c) => c.friend.handle)).toEqual(['kim']);
  });

  it('puts the playing friend ahead of the one who is merely here', () => {
    const cast = activeFriends(
      [
        friend({ id: 1, handle: 'ana', online: true }),
        friend({ id: 2, handle: 'kim', online: true, nowPlaying: song(true, 10_000) }),
      ],
      HERE,
      NOW,
    );
    expect(cast.map((c) => c.friend.handle)).toEqual(['kim', 'ana']);
  });

  // "She just put something on" is the better card, and it is also what keeps
  // the top of the list turning over as an evening moves.
  it('breaks a tie on the most recently started song', () => {
    const cast = activeFriends(
      [
        friend({ id: 1, handle: 'ana', nowPlaying: song(true, 10_000, { since: Math.floor((NOW - 600_000) / 1000) }) }),
        friend({ id: 2, handle: 'kim', nowPlaying: song(true, 10_000, { since: Math.floor((NOW - 30_000) / 1000) }) }),
      ],
      HERE,
      NOW,
    );
    expect(cast.map((c) => c.friend.handle)).toEqual(['kim', 'ana']);
  });

  // The order has to be TOTAL. Two friends alike in every number must not swap
  // places between two renders a second apart: the rail is a row of buttons,
  // and a row of buttons that reorders under a finger sends a song to the
  // wrong person.
  it('is stable to the last tie, and orders identical friends by handle', () => {
    const twins = [
      friend({ id: 1, handle: 'zoe', nowPlaying: song(true, 10_000) }),
      friend({ id: 2, handle: 'ana', nowPlaying: song(true, 10_000) }),
    ];
    const once = activeFriends(twins, HERE, NOW).map((c) => c.friend.handle);
    const twice = activeFriends([...twins].reverse(), HERE, NOW).map((c) => c.friend.handle);
    expect(once).toEqual(['ana', 'zoe']);
    expect(twice).toEqual(once);
  });

  it('carries the standing it decided, not just the friend', () => {
    const cast = activeFriends([friend({ nowPlaying: song(false, 10_000) })], HERE, NOW);
    expect(cast[0]!.standing).toBe('paused');
  });
});
