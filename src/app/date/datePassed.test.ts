/**
 * The Music Date ledger, and the two things it must never do.
 *
 * The module's own header names the bug that made it observable: "The Music
 * Date chip said '172 waiting' over a deck that was empty, because 172 was
 * every audition this listener owned and the deck had already ruled on all of
 * them. A count that disagrees with the room it opens is worse than no count."
 *
 * And `readPassed` carries the other one in its doc comment: it hands back "A
 * COPY, because Music Date mutates its own set in place and then writes it
 * back; handing out the cache would let that edit the ledger unannounced."
 *
 * Both are silent failures. Neither throws, neither logs, and both are one
 * line to reintroduce.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BUFFER_AHEAD,
  SNIPPET_SECONDS,
  VERDICT_PX,
  FLING_MS,
  passedSet,
  passedVersion,
  readPassed,
  snippetStart,
  subscribePassed,
  writePassed,
} from './datePassed.ts';

const KEY = 'attackfm-date-passed';

beforeEach(() => {
  // The parsed ledger is cached in module state, so it outlives the per-test
  // localStorage clear; writing an empty one is the module's own reset seam.
  writePassed(new Set());
  localStorage.clear();
});

describe('readPassed hands out a copy', () => {
  it('REGRESSION: mutating what it returns does not touch the ledger', () => {
    writePassed(new Set([1, 2, 3]));
    const mine = readPassed();
    mine.add(999);
    mine.delete(1);
    expect([...readPassed()].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(passedSet().has(999)).toBe(false);
  });

  it('gives a different Set each time it is asked', () => {
    writePassed(new Set([1]));
    expect(readPassed()).not.toBe(readPassed());
  });

  it('and `passedSet` deliberately does NOT copy, for read-only callers', () => {
    /*
     * The third case, and the one that says the copy above is a choice rather
     * than an accident: a counter testing membership on every render should
     * not allocate a Set per row, so there are two functions and they differ.
     */
    writePassed(new Set([1]));
    expect(passedSet()).toBe(passedSet());
    expect(passedSet()).not.toBe(readPassed());
  });

  it('survives a write taken FROM readPassed, which is the real call pattern', () => {
    // Music Date reads, mutates its copy, and writes it back.
    writePassed(new Set([1]));
    const working = readPassed();
    working.add(2);
    writePassed(working);
    expect([...passedSet()].sort((a, b) => a - b)).toEqual([1, 2]);
  });
});

describe('the ledger notifies, so a count cannot disagree with its room', () => {
  it('wakes every subscriber on a write', () => {
    let woke = 0;
    const off = subscribePassed(() => {
      woke += 1;
    });
    writePassed(new Set([1]));
    expect(woke).toBe(1);
    writePassed(new Set([1, 2]));
    expect(woke).toBe(2);
    off();
    writePassed(new Set([1, 2, 3]));
    expect(woke).toBe(2);
  });

  it('notifies AFTER the write, so a listener that re-reads sees the new ledger', () => {
    // Stated because "before" and "after" both compile and only one of them
    // gives the chip the number it is about to draw.
    let seen: number[] = [];
    const off = subscribePassed(() => {
      seen = [...passedSet()];
    });
    writePassed(new Set([7]));
    expect(seen).toEqual([7]);
    off();
  });

  it('bumps the version on every write, so a snapshot comparison sees it', () => {
    const before = passedVersion();
    writePassed(new Set([1]));
    expect(passedVersion()).toBe(before + 1);
    // Even a write with the same contents: the version is a write counter, not
    // a content hash, and `useSyncExternalStore` needs a value that moves.
    writePassed(new Set([1]));
    expect(passedVersion()).toBe(before + 2);
  });
});

describe('persistence', () => {
  it('writes the ledger out as ids', () => {
    writePassed(new Set([3, 1, 2]));
    expect(JSON.parse(localStorage.getItem(KEY) ?? '[]')).toEqual([3, 1, 2]);
  });

  it('caps the stored ledger, keeping the most recent passes', () => {
    // "the cap keeps a heavy swiper from growing the entry forever."
    writePassed(new Set(Array.from({ length: 1000 }, (_, i) => i)));
    const stored = JSON.parse(localStorage.getItem(KEY) ?? '[]') as number[];
    expect(stored).toHaveLength(800);
    expect(stored[799]).toBe(999);
  });

  it('keeps the whole ledger in memory even when the stored one is capped', () => {
    // The cap is about the storage entry, not about what this session knows.
    writePassed(new Set(Array.from({ length: 1000 }, (_, i) => i)));
    expect(passedSet().size).toBe(1000);
  });

  it('carries on when storage refuses the write', () => {
    // "Storage refusing just means passes forget across launches."
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(() => writePassed(new Set([1]))).not.toThrow();
    expect(passedSet().has(1)).toBe(true);
    setItem.mockRestore();
  });

  const reload = async () => {
    vi.resetModules();
    return import('./datePassed.ts');
  };

  it('comes back off disk on the next launch', async () => {
    localStorage.setItem(KEY, JSON.stringify([4, 5, 6]));
    const m = await reload();
    expect([...m.passedSet()].sort((a, b) => a - b)).toEqual([4, 5, 6]);
  });

  it('reads a torn entry as no passes, which only means a rerun of old cards', async () => {
    localStorage.setItem(KEY, 'not json');
    expect((await reload()).passedSet().size).toBe(0);

    localStorage.setItem(KEY, '{"not":"an array"}');
    expect((await reload()).passedSet().size).toBe(0);
  });

  it('drops anything in the stored list that is not an id', async () => {
    localStorage.setItem(KEY, JSON.stringify([1, 'two', null, 3]));
    const m = await reload();
    expect([...m.passedSet()].sort((a, b) => a - b)).toEqual([1, 3]);
  });
});

describe('snippetStart', () => {
  it('opens a short track from the top', () => {
    // Under 45 s there is no intro to skip past.
    expect(snippetStart(30)).toBe(0);
    expect(snippetStart(44)).toBe(0);
    expect(snippetStart(45)).toBeGreaterThan(0);
  });

  it('skips the intro on an ordinary song', () => {
    expect(snippetStart(200)).toBe(60);
    expect(snippetStart(100)).toBe(30);
  });

  it('CAPS the skip, so a long track does not open on its bridge', () => {
    // 30% of a twenty-minute piece would be six minutes in.
    expect(snippetStart(1200)).toBe(60);
    expect(snippetStart(3600)).toBe(60);
  });

  it('opens from the top when the duration is not a number', () => {
    expect(snippetStart(Infinity)).toBe(0);
    expect(snippetStart(NaN)).toBe(0);
  });
});

describe('the deck constants', () => {
  it('are the ones the page and the cache both plan against', () => {
    // These are read by DatePage (the gesture) and by cacheHotness (the
    // buffer). Pinned so a change in one is a change everywhere.
    expect(SNIPPET_SECONDS).toBe(25);
    expect(BUFFER_AHEAD).toBe(8);
    expect(VERDICT_PX).toBe(90);
    expect(FLING_MS).toBe(280);
  });
});
