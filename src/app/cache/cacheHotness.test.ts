/**
 * The ranking signal: which songs the phone should hold.
 *
 * `rankHotness` says of its weights that "the weights are ordinal rather than
 * measured - what matters is the ORDER". So this file asserts the ORDER, not
 * the numbers: every case is "this signal beats that one", which is the claim
 * the module makes and the thing a future re-weighting must preserve.
 *
 * Two of the cases are transcriptions of comments that describe a bug the code
 * is written to avoid, rather than a behaviour anyone would think to check:
 *
 *   - a song on two playlists must score as ONE signal recorded twice, not as
 *     two signals agreeing - "add it per list and a song on two of them scores
 *     1400, which would put it above liked and quietly invert the whole order";
 *   - a favourites call that fails leaves `liked: -1`, because that IS "the
 *     difference between 'you have no liked songs' and 'we could not ask'".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../server.ts';

/**
 * The three reads `rankHotness` makes, stubbed. `remotePath` and
 * `trackIdFromPath` are kept REAL through `importActual`: they are the key
 * spelling this whole module is expressed in, and a hand-written stand-in for
 * them would be a second implementation the test could pass against while the
 * app used the first.
 */
const fetchRemoteFavorites = vi.fn();
const fetchRemotePlaylists = vi.fn();
const fetchHome = vi.fn();

vi.mock('../server.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server.ts')>();
  return {
    remotePath: actual.remotePath,
    trackIdFromPath: actual.trackIdFromPath,
    fetchRemoteFavorites,
    fetchRemotePlaylists,
    fetchHome,
  };
});

const { DATE_CACHE_TARGET, rankHotness, setDateDeck } = await import('./cacheHotness.ts');
const { remotePath } = await import('../server.ts');

const session = { url: 'http://hub.test', token: 't' } as unknown as ServerSession;

/** An empty answer from every signal, which each test then overrides. */
function quietServer(): void {
  fetchRemoteFavorites.mockResolvedValue([]);
  fetchRemotePlaylists.mockResolvedValue([]);
  fetchHome.mockResolvedValue({
    recent: [],
    heavy: [],
    fresh: [],
    jumpBackIn: [],
    topArtists: [],
    mixes: [],
    ai: false,
  });
}

/** Where `id` came in the ranking, or -1. */
const rankOf = (keys: string[], id: number) => keys.indexOf(remotePath(id));

beforeEach(() => {
  setDateDeck([]);
  quietServer();
});

describe('rankHotness: the order of the signals', () => {
  it('puts the Date deck ahead of everything, including likes', async () => {
    /*
     * Not because a Date matters more than a song you love, but because of
     * WHEN it is needed: a Date is judged in about four seconds and then gone,
     * so the round trip has to land inside the swipe. A liked song is a
     * permanent resident and will be cached on any pass.
     */
    setDateDeck([remotePath(1)]);
    fetchRemoteFavorites.mockResolvedValue([2]);
    const { keys, reasons } = await rankHotness(session);
    expect(keys[0]).toBe(remotePath(1));
    expect(keys[1]).toBe(remotePath(2));
    expect(reasons.get(remotePath(1))).toBe('up next on Dates');
  });

  it('ranks liked over playlisted over on-repeat over recent over new', async () => {
    fetchRemoteFavorites.mockResolvedValue([10]);
    fetchRemotePlaylists.mockResolvedValue([{ tracks: [20] }]);
    fetchHome.mockResolvedValue({
      recent: [40],
      heavy: [30],
      fresh: [50],
      jumpBackIn: [],
      topArtists: [],
      mixes: [],
      ai: false,
    });
    const { keys } = await rankHotness(session);
    expect(keys).toEqual([10, 20, 30, 40, 50].map((n) => remotePath(n)));
  });

  it('keeps the Date deck in deck order', async () => {
    // 2000 - i, so the next card outranks the one after it.
    setDateDeck([remotePath(7), remotePath(8), remotePath(9)]);
    const { keys } = await rankHotness(session);
    expect(keys).toEqual([remotePath(7), remotePath(8), remotePath(9)]);
  });

  it('decays recency down the list, with a floor', async () => {
    // "the last thing played outranks the fortieth" - Math.max(40, 250 - i * 5).
    fetchHome.mockResolvedValue({
      recent: Array.from({ length: 60 }, (_, i) => i + 1),
      heavy: [],
      fresh: [],
      jumpBackIn: [],
      topArtists: [],
      mixes: [],
      ai: false,
    });
    const { keys } = await rankHotness(session);
    expect(rankOf(keys, 1)).toBeLessThan(rankOf(keys, 40));
    // Past the floor everything ties, and a tie is not an inversion.
    expect(rankOf(keys, 45)).toBeLessThan(keys.length);
  });

  it('flattens play counts so one obsession cannot crowd the cache out', async () => {
    // 300 + min(200, sqrt(plays) * 40): the 200-play song and the 40-play song
    // are both "yours", and a raw count would let one of them win outright.
    fetchHome.mockResolvedValue({
      recent: [],
      heavy: [],
      heavyPlays: [
        { id: 1, plays: 10_000 },
        { id: 2, plays: 25 },
      ],
      fresh: [],
      jumpBackIn: [],
      topArtists: [],
      mixes: [],
      ai: false,
    });
    fetchRemoteFavorites.mockResolvedValue([3]);
    const { keys } = await rankHotness(session);
    // Even at ten thousand plays it does not reach a like.
    expect(keys[0]).toBe(remotePath(3));
    expect(rankOf(keys, 1)).toBeLessThan(rankOf(keys, 2));
  });
});

describe('rankHotness: a song on two playlists', () => {
  it('scores it ONCE, so it cannot leapfrog a liked song', async () => {
    /*
     * The bug the `Set` in the source prevents, stated as the thing a listener
     * would see: a song that happens to sit on two of your playlists would
     * score 1400 and outrank a song you actually pressed the heart on -
     * "quietly inverting the whole order this block just claimed to keep".
     */
    fetchRemoteFavorites.mockResolvedValue([1]);
    fetchRemotePlaylists.mockResolvedValue([
      { tracks: [2] },
      { tracks: [2] },
      { tracks: [2] },
    ]);
    const { keys } = await rankHotness(session);
    expect(keys[0]).toBe(remotePath(1));
    expect(keys[1]).toBe(remotePath(2));
  });

  it('still ranks every track in every list', async () => {
    // The dedupe must not lose the second list's other songs.
    fetchRemotePlaylists.mockResolvedValue([{ tracks: [1, 2] }, { tracks: [2, 3] }]);
    const { keys } = await rankHotness(session);
    expect(new Set(keys)).toEqual(new Set([1, 2, 3].map((n) => remotePath(n))));
  });

  it('is deliberately flat: position in a list says nothing', async () => {
    fetchRemotePlaylists.mockResolvedValue([{ tracks: [1, 2, 3] }]);
    const { reasons } = await rankHotness(session);
    for (const n of [1, 2, 3]) expect(reasons.get(remotePath(n))).toBe('in a playlist');
  });
});

describe('rankHotness: a signal that will not load', () => {
  it('reports -1 for likes it could not ask about', async () => {
    // Not zero. Zero is an answer; -1 is the absence of one, and the settings
    // pane says two different things.
    fetchRemoteFavorites.mockRejectedValue(new Error('offline'));
    const { liked } = await rankHotness(session);
    expect(liked).toBe(-1);
  });

  it('reports 0 when the server genuinely says none', async () => {
    fetchRemoteFavorites.mockResolvedValue([]);
    const { liked } = await rankHotness(session);
    expect(liked).toBe(0);
  });

  it('carries on ranking when any one signal fails', async () => {
    // "one fewer input, not a failure" - three times over.
    fetchRemoteFavorites.mockRejectedValue(new Error('nope'));
    fetchRemotePlaylists.mockRejectedValue(new Error('nope'));
    fetchHome.mockRejectedValue(new Error('nope'));
    setDateDeck([remotePath(1)]);
    const { keys, liked } = await rankHotness(session);
    expect(keys).toEqual([remotePath(1)]);
    expect(liked).toBe(-1);
  });

  it('tolerates an older server that omits whole shelves', async () => {
    // Every `?? []` in the feed block, exercised at once.
    fetchHome.mockResolvedValue({});
    await expect(rankHotness(session)).resolves.toMatchObject({ keys: [] });
  });
});

describe('the reason a key is held', () => {
  it('records the FIRST reason, which is the strongest one', async () => {
    // `if (!reasons.has(key))`. A song that is both liked and on repeat is
    // explained by the like, because that is the signal that put it top.
    fetchRemoteFavorites.mockResolvedValue([1]);
    fetchHome.mockResolvedValue({ heavy: [1], recent: [1] });
    const { reasons } = await rankHotness(session);
    expect(reasons.get(remotePath(1))).toBe('liked');
  });

  it('scores a song on several counts, as it should', async () => {
    // "something both liked and on repeat is the surest bet on the phone".
    fetchRemoteFavorites.mockResolvedValue([1, 2]);
    fetchHome.mockResolvedValue({ heavy: [1] });
    const { keys } = await rankHotness(session);
    expect(keys[0]).toBe(remotePath(1));
  });
});

describe('setDateDeck', () => {
  it('caps the deck at the cache target', async () => {
    const many = Array.from({ length: 100 }, (_, i) => remotePath(i + 1));
    setDateDeck(many);
    const { keys } = await rankHotness(session);
    expect(keys).toHaveLength(DATE_CACHE_TARGET);
  });

  it('persists, so the NEXT launch warms the deck before anyone opens it', async () => {
    /*
     * The launch sweep fires ninety seconds in, long before anyone navigates
     * to Dates. With an in-memory hint that pass would warm nothing, and
     * "instant" would only start being true on the second visit of a session.
     */
    setDateDeck([remotePath(5), remotePath(6)]);
    expect(JSON.parse(localStorage.getItem('attackfm-date-deck') ?? 'null')).toEqual([
      remotePath(5),
      remotePath(6),
    ]);

    // A fresh module registry is a fresh launch: the deck comes back off disk.
    vi.resetModules();
    const relaunched = await import('./cacheHotness.ts');
    const { keys } = await relaunched.rankHotness(session);
    expect(keys).toEqual([remotePath(5), remotePath(6)]);
  });

  it('ignores a torn or hand-edited entry rather than throwing at boot', async () => {
    localStorage.setItem('attackfm-date-deck', '{"not":"an array"}');
    vi.resetModules();
    const relaunched = await import('./cacheHotness.ts');
    await expect(relaunched.rankHotness(session)).resolves.toMatchObject({ keys: [] });

    localStorage.setItem('attackfm-date-deck', 'not json at all');
    vi.resetModules();
    const again = await import('./cacheHotness.ts');
    await expect(again.rankHotness(session)).resolves.toMatchObject({ keys: [] });
  });

  it('drops non-strings out of a mixed stored deck', async () => {
    localStorage.setItem('attackfm-date-deck', JSON.stringify([remotePath(1), 42, null]));
    vi.resetModules();
    const relaunched = await import('./cacheHotness.ts');
    const { keys } = await relaunched.rankHotness(session);
    expect(keys).toEqual([remotePath(1)]);
  });

  it('skips a deck entry that is not a library path', async () => {
    // `trackIdFromPath` answers null for a local file; it simply is not ranked.
    setDateDeck(['/Users/matt/Music/song.flac', remotePath(3)]);
    const { keys } = await rankHotness(session);
    expect(keys).toEqual([remotePath(3)]);
  });
});
