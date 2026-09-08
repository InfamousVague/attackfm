import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Track } from '../core/tauri.ts';
import type { ServerSession } from '../server.ts';

/**
 * Smart shuffle: the pool, the cadence and the badge.
 *
 * Three things here can go wrong quietly. The POOL can be fetched for a queue
 * that has since changed, and deal a suggestion computed for a list the
 * listener has left. The CADENCE can drift, and a shuffle with suggestions in
 * it becomes a radio station wearing a shuffle icon. And the BADGE reads a
 * map of picks that has to be pruned to the live queue, or a song the
 * listener queued themselves months later still says "DJ pick".
 *
 * The module holds all of that in file-scope state, so every test starts by
 * clearing it - `clearEnhancers()` is the module's own seam for exactly this
 * and is what the mode's off switch calls.
 */
vi.mock('../api/http.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api/http.ts')>()),
  request: vi.fn(),
}));

import { request } from '../api/http.ts';
import {
  clearEnhancers,
  enhancerLabel,
  nextEnhancer,
  primeEnhancers,
  SMART_SHUFFLE_LABEL_KEY,
} from './smartShuffle.ts';

const asked = vi.mocked(request);

const session = { url: 'https://matt.attack.fm', token: 't' } as unknown as ServerSession;

function song(id: number): Track {
  return { path: `afm://${id}`, title: `Song ${id}`, artist: 'A', album: 'B', duration: 1 } as Track;
}

const idOf = (path: string) => {
  const n = Number(path.replace('afm://', ''));
  return Number.isFinite(n) ? n : null;
};
const resolve = (id: number) => song(id);

/** Warm the pool for `queue` with whatever the hub is set up to answer. */
function prime(queue: Track[]) {
  return primeEnhancers(session, queue, resolve, idOf);
}

/** The hub's next answer: these ids, in these lanes. */
function hubOffers(trackIds: number[], lanes: Record<string, string> = {}) {
  asked.mockResolvedValueOnce({ trackIds, lanes } as never);
}

/** The step index on which a pick is due - the cadence is one in four. */
const DUE = 3;

beforeEach(() => {
  clearEnhancers();
});

afterEach(() => {
  clearEnhancers();
});

describe('the label key', () => {
  it('is a catalogue key, not a sentence', () => {
    // The mode's only visible difference from plain shuffle is a sparkle, so
    // the accessible name carries the whole explanation - and it has to be
    // translatable, which means the module must not hold English.
    expect(SMART_SHUFFLE_LABEL_KEY).toBe('player.smartShuffleLabel');
  });
});

describe('priming the pool', () => {
  it('asks the hub for songs that belong with this queue', async () => {
    hubOffers([9, 10]);
    await prime([song(1), song(2), song(3)]);
    expect(asked).toHaveBeenCalledTimes(1);
    const [url, path, init] = asked.mock.calls[0] as [string, string, { body: string }];
    expect(url).toBe('https://matt.attack.fm');
    expect(path).toBe('/api/queue/enhance');
    expect(JSON.parse(init.body)).toEqual({ trackIds: [1, 2, 3], count: 6 });
  });

  it('does not ask again for the same queue', async () => {
    hubOffers([9, 10]);
    await prime([song(1), song(2), song(3)]);
    await prime([song(1), song(2), song(3)]);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('treats a RESHUFFLE of the same songs as the same question', async () => {
    hubOffers([9, 10]);
    await prime([song(1), song(2), song(3)]);
    await prime([song(3), song(1), song(2)]);
    // The key is membership, order-independent: shuffling the same list is
    // not a new queue, and re-asking on every reshuffle would put a network
    // round trip in the middle of every track change.
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('asks again when the queue really changes', async () => {
    hubOffers([9]);
    await prime([song(1), song(2), song(3)]);
    hubOffers([11]);
    await prime([song(1), song(2), song(4)]);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('does not ask at all with no session', async () => {
    await primeEnhancers(null, [song(1), song(2), song(3)], resolve, idOf);
    expect(asked).not.toHaveBeenCalled();
    expect(nextEnhancer(DUE, new Set())).toBeNull();
  });

  it('does not ask for a queue too short to have a character', async () => {
    await prime([song(1), song(2)]);
    expect(asked).not.toHaveBeenCalled();
    // The third case: one more song and the same call does go out.
    hubOffers([9]);
    await prime([song(1), song(2), song(3)]);
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('does not ask for a local-only queue the server could not reason about', async () => {
    const local = [1, 2, 3].map((n) => ({ ...song(n), path: `/Music/${n}.mp3` }) as Track);
    await prime(local);
    expect(asked).not.toHaveBeenCalled();
  });

  it('degrades to plain shuffle when the hub refuses or is too old for the route', async () => {
    asked.mockRejectedValueOnce(new Error('404'));
    await prime([song(1), song(2), song(3)]);
    expect(nextEnhancer(DUE, new Set())).toBeNull();
  });

  it('does not ask again after a refusal for the same queue', async () => {
    asked.mockRejectedValueOnce(new Error('404'));
    await prime([song(1), song(2), song(3)]);
    await prime([song(1), song(2), song(3)]);
    // An empty answer is the server's last word on this queue; asking on
    // every step would be a round trip per track change for nothing.
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it('asks again once a pool that HAD songs is spent', async () => {
    hubOffers([9]);
    await prime([song(1), song(2), song(3)]);
    expect(nextEnhancer(DUE, new Set())?.track.path).toBe('afm://9');
    // Spent to the bottom, and the fetch that filled it came back with
    // songs - so there may be more behind it. A long session must not run
    // dry after six picks.
    hubOffers([12]);
    await prime([song(1), song(2), song(3)]);
    expect(asked).toHaveBeenCalledTimes(2);
  });

  it('never deals a song already in the queue', async () => {
    hubOffers([2, 9]);
    await prime([song(1), song(2), song(3)]);
    // #2 is in the line; the listener will hear it as a queue track.
    expect(nextEnhancer(DUE, new Set())?.track.path).toBe('afm://9');
  });

  it('drops rows the library cannot resolve', async () => {
    hubOffers([9, 99]);
    await primeEnhancers(session, [song(1), song(2), song(3)], (id) => (id === 99 ? undefined : song(id)), idOf);
    expect(nextEnhancer(DUE, new Set())?.track.path).toBe('afm://9');
    expect(nextEnhancer(DUE + 4, new Set())).toBeNull();
  });

  it('replays a prime that arrived while another was in flight', async () => {
    // The queue moved during the round trip, so the answer that is landing is
    // already stale.
    let land: (v: unknown) => void = () => {};
    asked.mockReturnValueOnce(new Promise((res) => (land = res)) as never);
    const first = prime([song(1), song(2), song(3)]);
    hubOffers([12]);
    const second = prime([song(4), song(5), song(6)]);
    land({ trackIds: [9], lanes: {} });
    await first;
    await second;
    expect(asked).toHaveBeenCalledTimes(2);
    expect(nextEnhancer(DUE, new Set())?.track.path).toBe('afm://12');
  });
});

describe('the cadence', () => {
  it('deals on one step in four, and not on the other three', async () => {
    hubOffers([9, 10]);
    await prime([song(1), song(2), song(3)]);
    expect(nextEnhancer(0, new Set())).toBeNull();
    expect(nextEnhancer(1, new Set())).toBeNull();
    expect(nextEnhancer(2, new Set())).toBeNull();
    expect(nextEnhancer(3, new Set())).not.toBeNull();
    // Counted, not rolled: a coin flip clusters, and clustering is what
    // would make this feel like the app hijacking the queue.
    expect(nextEnhancer(4, new Set())).toBeNull();
    expect(nextEnhancer(7, new Set())).not.toBeNull();
  });

  it('deals nothing at all from an empty pool, whatever the step', async () => {
    expect(nextEnhancer(3, new Set())).toBeNull();
    expect(nextEnhancer(7, new Set())).toBeNull();
  });

  it('skips a pick the caller has already taken, and deals the next one', async () => {
    hubOffers([9, 10]);
    await prime([song(1), song(2), song(3)]);
    // `taken` is the recent trail plus the queue as it stands now.
    expect(nextEnhancer(DUE, new Set(['afm://9']))?.track.path).toBe('afm://10');
  });

  it('deals nothing when every pick is spoken for', async () => {
    hubOffers([9, 10]);
    await prime([song(1), song(2), song(3)]);
    expect(nextEnhancer(DUE, new Set(['afm://9', 'afm://10']))).toBeNull();
  });

  it('spends a pick - it is not dealt twice', async () => {
    hubOffers([9, 10]);
    await prime([song(1), song(2), song(3)]);
    expect(nextEnhancer(DUE, new Set())?.track.path).toBe('afm://9');
    expect(nextEnhancer(DUE + 4, new Set())?.track.path).toBe('afm://10');
    expect(nextEnhancer(DUE + 8, new Set())).toBeNull();
  });
});

describe('the badge', () => {
  it('names the lane the hub dealt from', async () => {
    hubOffers([9, 10, 11], { 9: 'new', 10: 'repeat', 11: 'similar' });
    await prime([song(1), song(2), song(3)]);
    nextEnhancer(DUE, new Set());
    nextEnhancer(DUE + 4, new Set());
    nextEnhancer(DUE + 8, new Set());
    expect(enhancerLabel('afm://9')).toBe('DJ pick · New');
    expect(enhancerLabel('afm://10')).toBe('DJ pick · On repeat');
    expect(enhancerLabel('afm://11')).toBe('DJ pick · Similar');
  });

  it('badges an unexplained pick from a hub that has no lanes', async () => {
    hubOffers([9]);
    await prime([song(1), song(2), song(3)]);
    nextEnhancer(DUE, new Set());
    // A pick from an older hub is still a pick, just an unexplained one.
    expect(enhancerLabel('afm://9')).toBe('DJ pick');
  });

  it('ignores a lane the hub invented', async () => {
    hubOffers([9], { 9: 'sideways' });
    await prime([song(1), song(2), song(3)]);
    expect(nextEnhancer(DUE, new Set())?.lane).toBeNull();
    expect(enhancerLabel('afm://9')).toBe('DJ pick');
  });

  it('says nothing about a song nobody dealt', () => {
    expect(enhancerLabel('afm://1')).toBeNull();
  });

  it('keeps badging a pick after the mode is switched off', async () => {
    hubOffers([9]);
    await prime([song(1), song(2), song(3)]);
    nextEnhancer(DUE, new Set());
    // The pick was the DJ's and still is, whatever the button says now.
    clearEnhancers([song(1), song(9)]);
    expect(enhancerLabel('afm://9')).toBe('DJ pick');
  });

  it('forgets a pick that has left the line', async () => {
    hubOffers([9]);
    await prime([song(1), song(2), song(3)]);
    nextEnhancer(DUE, new Set());
    expect(enhancerLabel('afm://9')).toBe('DJ pick');
    // Removed from the queue: it is an ordinary song again, and the badge
    // must not follow it into some future queue the listener built by hand.
    clearEnhancers([song(1), song(2), song(3)]);
    expect(enhancerLabel('afm://9')).toBeNull();
  });

  it('prunes on a prime as well as on a clear', async () => {
    hubOffers([9]);
    await prime([song(1), song(2), song(3)]);
    nextEnhancer(DUE, new Set());
    hubOffers([]);
    await prime([song(4), song(5), song(6)]);
    expect(enhancerLabel('afm://9')).toBeNull();
  });
});

describe('the pool key ignores the DJ’s own additions', () => {
  it('does not treat a dealt pick landing in the queue as a new question', async () => {
    hubOffers([9, 10]);
    await prime([song(1), song(2), song(3)]);
    const pick = nextEnhancer(DUE, new Set());
    expect(pick?.track.path).toBe('afm://9');
    // The player slots the pick into the queue. That is the ANSWER, not a
    // change of the listener's question - so it must not look like a new
    // queue and throw away the rest of the pool.
    await prime([song(1), song(2), song(3), song(9)]);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(nextEnhancer(DUE + 4, new Set())?.track.path).toBe('afm://10');
  });
});

describe('clearEnhancers', () => {
  it('drops the pool so the next prime asks again', async () => {
    hubOffers([9]);
    await prime([song(1), song(2), song(3)]);
    clearEnhancers();
    expect(nextEnhancer(DUE, new Set())).toBeNull();
    hubOffers([12]);
    await prime([song(1), song(2), song(3)]);
    expect(asked).toHaveBeenCalledTimes(2);
  });
});
