/**
 * `planCache` - the half of the sweep that can delete a file.
 *
 * The module header states two rules, and the first is the one this file is
 * mostly about:
 *
 *   "the budget governs this cache only, never a pin. A song someone
 *    deliberately kept for a flight must not be deleted to make room for one
 *    an algorithm liked ... Unknown means untouchable."
 *
 * That is a promise about DATA LOSS, made by a pure function that already says
 * of itself "it should be checkable without a phone, a server or a disk". So
 * it is checked here without one.
 *
 * Every case is written as a disk state plus a ranking, because the interesting
 * failures all look the same from inside the function - a key comes out in the
 * wrong list - and only the surrounding fiction says which of them cost
 * somebody an album on a plane.
 */
import { describe, expect, it } from 'vitest';
import { planCache } from './cacheSweep.ts';

/** What the sweep sees: `afm://<id>` library paths. */
const key = (n: number) => `afm://${n}`;

const MB = 1024 ** 2;
/** cacheSweep's own ASSUMED_BYTES, for a track the index cannot size. */
const ASSUMED = 35 * MB;

/** A plan over a library where every song is `size` bytes. */
function plan(opts: {
  ranked: number[];
  sizes?: Record<number, number>;
  onDisk?: number[];
  owned?: number[];
  limitBytes: number;
}) {
  const sizes = new Map<string, number>();
  for (const [id, bytes] of Object.entries(opts.sizes ?? {})) sizes.set(key(Number(id)), bytes);
  return planCache({
    ranked: opts.ranked.map(key),
    sizes,
    onDisk: new Set((opts.onDisk ?? []).map(key)),
    owned: new Set((opts.owned ?? []).map(key)),
    limitBytes: opts.limitBytes,
  });
}

describe('planCache: a manual pin is never evicted', () => {
  it('REGRESSION: the coldest pin on the disk survives a budget of nothing', () => {
    /*
     * The whole design in one case. Song 1 is pinned by hand and is not in the
     * ranking at all - as cold as a key can be. The budget is zero, so the
     * cache is being emptied completely.
     *
     * A sweep that evicted by "what is on disk and no longer wanted" would take
     * it, and the person who pinned it for a flight would find it gone. The
     * eviction list is built from `owned`, never from `onDisk`, and that is the
     * line this asserts.
     */
    const { keep, evict } = plan({
      ranked: [],
      onDisk: [1, 2],
      owned: [2],
      limitBytes: 0,
    });
    expect(keep).toEqual([]);
    expect(evict).toEqual([key(2)]);
    expect(evict).not.toContain(key(1));
  });

  it('survives being outranked by something hotter that needs the room', () => {
    // The other half of rotation: not "it went cold" but "something better
    // came along". A pin loses to neither.
    const { evict } = plan({
      ranked: [9, 8, 7],
      sizes: { 1: 100 * MB, 9: 100 * MB, 8: 100 * MB, 7: 100 * MB },
      onDisk: [1],
      owned: [],
      limitBytes: 150 * MB,
    });
    expect(evict).toEqual([]);
  });

  it('is untouchable even when it IS the top of the ranking', () => {
    // A pinned song that the ranking also loves is still not the cache's to
    // manage: it is skipped on the way in, so it can never arrive in `owned`
    // and can never leave through `evict`.
    const { keep, evict } = plan({
      ranked: [1, 2],
      sizes: { 1: 10 * MB, 2: 10 * MB },
      onDisk: [1],
      owned: [],
      limitBytes: 100 * MB,
    });
    expect(keep).toEqual([key(2)]);
    expect(evict).toEqual([]);
  });

  it('does not charge the budget for a pin, so pinning cannot shrink the cache', () => {
    /*
     * The comment beside the skip: "charging the budget for it would shrink
     * the cache every time someone pinned a song."
     *
     * Two 60 MB songs against a 100 MB budget. Song 1 is pinned. If the pin
     * were charged, only one of the two remaining songs would fit; because it
     * is not, `plannedBytes` counts only what the cache itself is holding.
     */
    const { keep, plannedBytes } = plan({
      ranked: [1, 2],
      sizes: { 1: 60 * MB, 2: 60 * MB },
      onDisk: [1],
      owned: [],
      limitBytes: 100 * MB,
    });
    expect(keep).toEqual([key(2)]);
    expect(plannedBytes).toBe(60 * MB);
  });

  it('DOES evict a cache-owned key that is also on disk', () => {
    /*
     * The third case, and the one that makes the other two mean anything: the
     * rule is not "never delete what is on the disk". A key this cache put
     * there, gone cold, is exactly what a sweep exists to remove - so a test
     * suite that only proved things survive would also pass against a function
     * that never deleted anything at all.
     */
    const { keep, evict } = plan({
      ranked: [],
      onDisk: [1, 2],
      owned: [1, 2],
      limitBytes: 0,
    });
    expect(keep).toEqual([]);
    expect(evict.sort()).toEqual([key(1), key(2)]);
  });
});

describe('planCache: filling the budget', () => {
  it('takes the ranking in order until the ceiling', () => {
    const { keep, plannedBytes } = plan({
      ranked: [1, 2, 3, 4],
      sizes: { 1: 30 * MB, 2: 30 * MB, 3: 30 * MB, 4: 30 * MB },
      limitBytes: 100 * MB,
    });
    expect(keep).toEqual([key(1), key(2), key(3)]);
    expect(plannedBytes).toBe(90 * MB);
  });

  it('SKIPS a file too big to fit rather than stopping at it', () => {
    /*
     * `continue`, not `break`, and the comment in the source says why: "a
     * single huge file near the ceiling should not stop every smaller song
     * behind it from fitting."
     *
     * A twenty-minute live track ranked second would otherwise cost the phone
     * every song ranked below it.
     */
    const { keep } = plan({
      ranked: [1, 2, 3],
      sizes: { 1: 10 * MB, 2: 500 * MB, 3: 10 * MB },
      limitBytes: 100 * MB,
    });
    expect(keep).toEqual([key(1), key(3)]);
  });

  it('assumes an average lossless song for a track the index cannot size', () => {
    // Skipping it would silently under-fill the disk; assuming 35 MB is the
    // documented choice.
    const { plannedBytes, keep } = plan({
      ranked: [1],
      sizes: {},
      limitBytes: 100 * MB,
    });
    expect(keep).toEqual([key(1)]);
    expect(plannedBytes).toBe(ASSUMED);
  });

  it('holds nothing at all when the budget is zero', () => {
    // The whole `if (limitBytes > 0)` block is skipped, so "off" means off
    // rather than "one song, because the first one always fits".
    const { keep, plannedBytes } = plan({
      ranked: [1, 2, 3],
      sizes: { 1: 1, 2: 1, 3: 1 },
      limitBytes: 0,
    });
    expect(keep).toEqual([]);
    expect(plannedBytes).toBe(0);
  });

  it('never exceeds the ceiling it was given', () => {
    const { plannedBytes } = plan({
      ranked: [1, 2, 3, 4, 5],
      sizes: { 1: 40 * MB, 2: 40 * MB, 3: 40 * MB, 4: 40 * MB, 5: 40 * MB },
      limitBytes: 100 * MB,
    });
    expect(plannedBytes).toBeLessThanOrEqual(100 * MB);
  });
});

describe('planCache: what leaves', () => {
  it('evicts exactly what this cache owns and no longer wants', () => {
    // One rule covers both halves of rotation - cold, and outranked - so there
    // is no second policy that could disagree with this one.
    const { keep, evict } = plan({
      ranked: [1, 2],
      sizes: { 1: 10 * MB, 2: 10 * MB, 3: 10 * MB },
      onDisk: [3],
      owned: [3],
      limitBytes: 100 * MB,
    });
    expect(keep).toEqual([key(1), key(2)]);
    expect(evict).toEqual([key(3)]);
  });

  it('leaves an owned key alone when it is still wanted', () => {
    const { evict } = plan({
      ranked: [1],
      sizes: { 1: 10 * MB },
      onDisk: [1],
      owned: [1],
      limitBytes: 100 * MB,
    });
    expect(evict).toEqual([]);
  });

  it('evicts an owned key the sweep could not afford this pass', () => {
    // It was ours, it is still ranked, and it simply does not fit any more.
    const { keep, evict } = plan({
      ranked: [1, 2],
      sizes: { 1: 90 * MB, 2: 90 * MB },
      onDisk: [2],
      owned: [2],
      limitBytes: 100 * MB,
    });
    expect(keep).toEqual([key(1)]);
    expect(evict).toEqual([key(2)]);
  });
});
