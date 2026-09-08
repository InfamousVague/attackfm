/**
 * `shuffled` - "a jumbled ORDER of exactly these songs".
 *
 * Nineteen lines, one of them a guard that looks like noise and is not. The
 * distinction the header draws is the whole point: this shuffles a COLLECTION
 * you are about to play, where the player's own shuffle switch is a mode that
 * "would outlive the page that asked".
 *
 * `Math.random` is stubbed rather than sampled, because a statistical test of a
 * shuffle is a flaky test of a shuffle: with a scripted sequence the swap order
 * is exact, and Fisher-Yates either walks it or it does not.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shuffled } from './shuffle.ts';

/** Feed `Math.random` a scripted sequence, looping if it is asked for more. */
function scripted(...values: number[]): void {
  let i = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => values[i++ % values.length] ?? 0);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what comes out', () => {
  it('is EXACTLY these songs, in some order', () => {
    const list = ['a', 'b', 'c', 'd', 'e'];
    scripted(0.1, 0.9, 0.4, 0.7);
    const out = shuffled(list);
    expect(out).toHaveLength(list.length);
    expect([...out].sort()).toEqual([...list].sort());
  });

  it('does NOT reorder the caller\'s array', () => {
    // A queue built from a playlist must not leave the playlist reordered - the
    // one thing a naive in-place Fisher-Yates would do.
    const list = ['a', 'b', 'c', 'd'];
    scripted(0.9, 0.1, 0.5);
    shuffled(list);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });

  it('really does move things', () => {
    // The third case: an implementation that returned a copy untouched would
    // pass both tests above.
    const list = ['a', 'b', 'c', 'd', 'e', 'f'];
    scripted(0.99, 0.01, 0.99, 0.01, 0.99);
    expect(shuffled(list)).not.toEqual(list);
  });

  it('walks the swaps Fisher-Yates prescribes', () => {
    /*
     * Four items, `random` pinned to 0, so every j is 0: the loop swaps
     * index 3 with 0, then 2 with 0, then 1 with 0.
     *   a b c d -> d b c a -> c b d a -> b c d a
     */
    scripted(0);
    expect(shuffled(['a', 'b', 'c', 'd'])).toEqual(['b', 'c', 'd', 'a']);
  });

  it('leaves the order alone when every draw picks the element itself', () => {
    // random just under 1 makes j === i at every step, which is a legal
    // shuffle outcome and must not corrupt the array.
    scripted(0.999999);
    expect(shuffled(['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('the degenerate inputs', () => {
  it('handles an empty list and a single song', () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled(['only'])).toEqual(['only']);
  });

  it('takes a readonly array and gives back a mutable one', () => {
    const frozen = Object.freeze(['a', 'b', 'c']);
    scripted(0);
    const out = shuffled(frozen);
    expect(() => out.push('d')).not.toThrow();
  });

  it('shuffles objects by reference, not by value', () => {
    const rows = [{ id: 1 }, { id: 2 }, { id: 3 }];
    scripted(0);
    const out = shuffled(rows);
    expect(out).toContain(rows[0]);
    expect(new Set(out).size).toBe(3);
  });
});
