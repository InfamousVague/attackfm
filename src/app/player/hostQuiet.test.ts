import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Jam } from '../server.ts';
import { hostWaiting } from './hostQuiet.ts';

/**
 * Whether a room's host is still there.
 *
 * Two surfaces ask - the queue panel, which greys the list, and the badge in
 * the transport row, which says so out loud - and both are claims about
 * somebody else's phone made from this one. Getting it wrong is not a visual
 * bug: a live host called quiet tells a room the music is about to stop when
 * it is not, and a departed host called live leaves everybody staring at a
 * frozen queue.
 *
 * The load-bearing part is WHOSE CLOCK. `hostSeenAt` is stamped by the hub,
 * so it can only be compared against the hub's own `now` - two phones with
 * different ideas of the time have to agree about the same room. The cases
 * below put this device's clock a long way from the hub's on purpose.
 */

/** A room as the hub reports one, with only the fields this predicate reads. */
function room(over: Partial<Jam>): Jam {
  return {
    id: 'j1',
    hostId: 1,
    hostName: 'Matt',
    members: ['Matt'],
    memberCount: 1,
    trackId: null,
    positionMs: 0,
    playing: true,
    queue: [],
    updatedAt: 0,
    ...over,
  } as Jam;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('hostWaiting', () => {
  it('never calls a host quiet when the hub does not report one', () => {
    // An older hub sends neither `hostSeenAt` nor `now`. Reading a missing
    // stamp as 0 would make every room on it permanently "waiting".
    expect(hostWaiting(room({}))).toBe(false);
    expect(hostWaiting(room({ now: Date.now() }))).toBe(false);
  });

  it('leaves a host that beat a moment ago alone', () => {
    // The host beats every 2.5s; two seconds of silence is the normal gap
    // between beats, not a departure.
    expect(hostWaiting(room({ now: 1_000_000, hostSeenAt: 998_000 }))).toBe(false);
  });

  it('waits at forty-five seconds and one, not at forty-five', () => {
    // `>`, not `>=`: the threshold is the last moment that still counts as
    // present, and the boundary is where a "waiting" that flickers on and
    // off between two beats would come from.
    expect(hostWaiting(room({ now: 1_045_000, hostSeenAt: 1_000_000 }))).toBe(false);
    expect(hostWaiting(room({ now: 1_045_001, hostSeenAt: 1_000_000 }))).toBe(true);
  });

  it('measures on the HUB’s clock, not on this device’s', () => {
    // Both stamps are the hub's, and they are decades away from this
    // machine's idea of the time. Anything reaching for Date.now() here
    // reports a host that beat one second ago as forty years quiet.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'));
    expect(hostWaiting(room({ now: 1_000_000, hostSeenAt: 999_000 }))).toBe(false);
  });

  it('falls back to when this device heard, for a hub that sends no clock', () => {
    // `receivedAt` is stamped by the provider as the reply lands, so it is
    // this device's clock - but so, then, is the comparison, and the two are
    // at least the same one.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'));
    const at = Date.now();
    expect(hostWaiting(room({ hostSeenAt: at - 1_000, receivedAt: at }))).toBe(false);
    expect(hostWaiting(room({ hostSeenAt: at - 60_000, receivedAt: at }))).toBe(true);
  });

  it('falls back to now, for a report carrying neither clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-07T00:00:00Z'));
    expect(hostWaiting(room({ hostSeenAt: Date.now() - 1_000 }))).toBe(false);
    expect(hostWaiting(room({ hostSeenAt: Date.now() - 60_000 }))).toBe(true);
  });

  it('prefers the hub’s clock over this device’s when both arrive', () => {
    // `now ?? receivedAt`: a device whose clock is minutes out must not be
    // able to declare a live room dead just by having a bad clock.
    const skewed = room({ now: 1_000_000, hostSeenAt: 999_000, receivedAt: 9_000_000 });
    expect(hostWaiting(skewed)).toBe(false);
  });
});
