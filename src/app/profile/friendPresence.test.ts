import { afterEach, describe, expect, it, vi } from 'vitest';
import { isOnline, listenedTime, seenAgo } from './friendPresence.ts';
import { setFormatLocale } from '../ux/format.ts';
import type { RegistryFriend } from '../servers/registry.ts';

/**
 * Three claims a friend row makes about a person, from two numbers.
 *
 * Every one of them fails silently. A window widened by a factor of a
 * thousand shows somebody who closed the app this morning as "online now" and
 * offers to start a groove with them; a stamp read in the wrong unit puts
 * everyone in 1970; a duration that drops the hours turns six hours of
 * listening into twenty minutes. None of that throws, and none of it is
 * visible in a rendered row unless you already know what the number was.
 *
 * The clock is frozen for the same reason: these are all "now minus then",
 * and a test whose answer depends on the second it ran in is a test that
 * fails for somebody else at midnight.
 */

/** A fixed present, so "90 seconds ago" means exactly that. */
const NOW = Date.UTC(2026, 8, 6, 12, 0, 0);

function at(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
}

/** Only the two fields these helpers read; the registry sends thirty. */
function friend(f: Partial<RegistryFriend>): RegistryFriend {
  return { handle: 'jo', seenAt: 0, ...f } as RegistryFriend;
}

afterEach(() => {
  vi.useRealTimers();
  setFormatLocale('en');
});

describe('isOnline', () => {
  it('believes the registry when it has an opinion, in both directions', () => {
    at(NOW);
    // The stamp says "here five seconds ago" in both cases; the flag wins,
    // because a hub that tracks presence knows about a closed tab and a
    // heartbeat that merely has not expired yet does not.
    const seenAt = NOW / 1000 - 5;
    expect(isOnline(friend({ online: true, seenAt }))).toBe(true);
    expect(isOnline(friend({ online: false, seenAt }))).toBe(false);
  });

  it('calls a friend who left an hour ago GONE', () => {
    at(NOW);
    // The failure this exists for: a window in the wrong unit (90 rather than
    // 90_000, or seconds mistaken for milliseconds) reports everyone who ever
    // opened the app as present, and the friends list lights up with people
    // who are asleep.
    expect(isOnline(friend({ seenAt: NOW / 1000 - 3600 }))).toBe(false);
  });

  it('holds the heartbeat window at a minute and a half, not a minute', () => {
    at(NOW);
    // The beat goes out every 30s (PRESENCE_MS in listeningShare.tsx) and the
    // window is deliberately three beats wide, so one dropped post on a slow
    // link does not blink a friend out of the list.
    expect(isOnline(friend({ seenAt: NOW / 1000 - 89 }))).toBe(true);
    expect(isOnline(friend({ seenAt: NOW / 1000 - 91 }))).toBe(false);
  });

  it('reads a stamp in seconds AND one in milliseconds as the same moment', () => {
    at(NOW);
    expect(isOnline(friend({ seenAt: NOW / 1000 - 10 }))).toBe(true);
    expect(isOnline(friend({ seenAt: NOW - 10_000 }))).toBe(true);
  });

  it('is not online for a friend who has never been seen', () => {
    at(NOW);
    // Zero is "no stamp", not "the epoch" - and the epoch is 56 years ago, so
    // an unguarded subtraction would be safely offline by accident rather
    // than on purpose. The guard is what makes a FUTURE zero-ish stamp safe.
    expect(isOnline(friend({ seenAt: 0 }))).toBe(false);
  });
});

describe('seenAgo', () => {
  it('says nothing at all when there is no stamp', () => {
    at(NOW);
    // Null, not "a moment ago" and not "56 years ago": the row hides the line
    // rather than inventing a fact about somebody it has never seen.
    expect(seenAgo(0)).toBeNull();
  });

  it('refuses a stamp from the future rather than counting backwards', () => {
    at(NOW);
    // Clock skew between two machines is ordinary. Intl would happily render
    // "in 3 minutes", which reads as a bug in the app rather than in a clock.
    expect(seenAgo(NOW / 1000 + 180)).toBeNull();
  });

  it('names the unit at each boundary rather than counting in one of them', () => {
    at(NOW);
    // The ladder this replaced was hand-rolled and said "4h ago" in English
    // in every branch. Intl picks the unit; what is pinned here is that it
    // gets a chance to - a helper that always passed seconds would say
    // "3,600 seconds ago" and still look like it worked.
    expect(seenAgo(NOW / 1000 - 45)).toMatch(/second/);
    expect(seenAgo(NOW / 1000 - 5 * 60)).toMatch(/minute/);
    expect(seenAgo(NOW / 1000 - 4 * 3600)).toMatch(/hour/);
    expect(seenAgo(NOW / 1000 - 3 * 86400)).toMatch(/day/);
  });

  it('reads seconds and milliseconds as the same moment', () => {
    at(NOW);
    // The registry stamps in seconds; some rows arrive already in ms. Both
    // must land on the same words, or the same friend reads differently
    // depending on which endpoint answered.
    expect(seenAgo(NOW / 1000 - 4 * 3600)).toBe(seenAgo(NOW - 4 * 3600 * 1000));
  });

  it("follows the app's language", () => {
    at(NOW);
    setFormatLocale('de');
    expect(seenAgo(NOW / 1000 - 4 * 3600)).toMatch(/Stunden/);
  });
});

describe('listenedTime', () => {
  it('KEEPS THE HOURS - six hours is not twenty minutes', () => {
    // The bug this catches is a unit slip: `formatTotal` counts SECONDS, so
    // handing it minutes divides the week by sixty and the friends
    // leaderboard quietly reports everyone as a light listener.
    expect(listenedTime(380)).toBe('6 hr 20 min');
  });

  it('gives the hour and the minute rather than a decimal hour', () => {
    // 89 and 91 minutes rounded to the hour are the same "1h", which is the
    // distinction the week glance was reaching for when it stopped rounding.
    expect(listenedTime(89)).not.toBe(listenedTime(91));
  });

  it('drops the minutes only when there are none', () => {
    expect(listenedTime(120)).toBe('2 hr');
  });

  it('reports under an hour in minutes', () => {
    expect(listenedTime(20)).toBe('20 min');
  });

  it('floors a negative or nonsense total at nothing', () => {
    // A server that answers with -1 (or with a subtraction that went the
    // wrong way) must not put "-1 min this week" under somebody's name.
    expect(listenedTime(-5)).toBe('0 min');
  });

  it('rounds to the minute before formatting', () => {
    expect(listenedTime(20.4)).toBe('20 min');
    expect(listenedTime(20.6)).toBe('21 min');
  });

  it("spells the unit in the app's language, not in English", () => {
    // The whole reason this is not `fmtMinutes` from stats.ts: that one
    // builds `${n} min` and puts an English unit under Japanese digits.
    setFormatLocale('de');
    expect(listenedTime(380)).toMatch(/Std\./);
  });
});
