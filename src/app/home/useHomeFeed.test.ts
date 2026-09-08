/**
 * The home feed's shelf arithmetic.
 *
 * Almost all of this hook is derivation: two server answers plus a library go
 * in, and eleven shelves come out. The hook is rendered rather than the pieces
 * called, because the shelves are only correct in relation to each other - the
 * "Made for you" dedupe is defined against the daylist and the station split,
 * and testing any one of them alone would prove nothing about the page.
 *
 * The two cases worth stating up front:
 *
 *   - THE DAYLIST'S TWO CLOCKS. The server has no timezone, so it writes four
 *     cards keyed to UTC quarter-days; the card is chosen by `getUTCHours()`
 *     and the WORD in front of it comes from `getHours()`. That is deliberate
 *     and it is easy to "tidy" into a single clock, which would hand a
 *     listener in Auckland somebody else's afternoon. Pinned in both halves.
 *
 *   - THE FOUR-TRACK FLOOR. A list whose ids do not resolve against the synced
 *     library must vanish rather than draw a shelf with one card in it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { Track } from '../core/tauri.ts';
import type { ServerSession } from '../server.ts';

const fetchHome = vi.fn();
const fetchCurator = vi.fn();

/** `trackIdFromPath` and `tracksOfHub` stay REAL: they are the path grammar
 *  the whole resolve step is expressed in, and a stand-in for them would be a
 *  second implementation this test could agree with while the app used the
 *  first. */
vi.mock('../server.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server.ts')>();
  return {
    trackIdFromPath: actual.trackIdFromPath,
    tracksOfHub: actual.tracksOfHub,
    fetchHome,
    fetchCurator,
  };
});

const readFeedCache = vi.fn(() => null);
const writeFeedCache = vi.fn();
vi.mock('../library/feedCache.ts', () => ({ readFeedCache, writeFeedCache }));

/** The translator echoes its key and its holes, so what is asserted is which
 *  daypart heading was chosen rather than what English calls it. */
vi.mock('../i18n/LocaleShell.tsx', () => ({
  useT: () => (key: string, options?: Record<string, unknown>) =>
    options ? `${key}:${JSON.stringify(options)}` : key,
}));

vi.mock('../nav/pageRefresh.tsx', () => ({ useRefreshNonce: () => 0 }));

const { useHomeFeed } = await import('./useHomeFeed.ts');

const session = { url: 'http://hub.test', token: 't' } as unknown as ServerSession;

const track = (id: number, over: Partial<Track> = {}): Track =>
  ({ path: `afm://${id}`, title: `Song ${id}`, artist: 'A', album: 'X', duration: 200, addedAt: id, ...over }) as Track;

/** Enough tracks to clear the four-track floor. */
const library = Array.from({ length: 12 }, (_, i) => track(i + 1));

const emptyHome = {
  recent: [],
  heavy: [],
  fresh: [],
  jumpBackIn: [],
  topArtists: [],
  mixes: [],
  ai: false,
};

const curatedList = (slug: string, over: Record<string, unknown> = {}) => ({
  slug,
  name: slug,
  blurb: '',
  trackIds: [1, 2, 3, 4],
  ...over,
});

/** Render the hook and wait for the mounted refresh to have landed. */
async function feed(opts: {
  home?: Record<string, unknown>;
  curator?: Record<string, unknown> | null;
  tracks?: Track[];
  forYou?: Track[];
  session?: ServerSession | null;
} = {}) {
  fetchHome.mockResolvedValue({ ...emptyHome, ...(opts.home ?? {}) });
  if (opts.curator === null) fetchCurator.mockRejectedValue(new Error('no curator'));
  else fetchCurator.mockResolvedValue({ lists: [], status: { ai: false }, ...(opts.curator ?? {}) });

  const s = opts.session === undefined ? session : opts.session;
  const view = renderHook(() => useHomeFeed(opts.tracks ?? library, s, opts.forYou));
  if (s) await waitFor(() => expect(view.result.current.feed).not.toBeNull());
  return view;
}

beforeEach(() => {
  readFeedCache.mockReturnValue(null);
  vi.useRealTimers();
});

describe('resolving ids against the synced library', () => {
  it('turns feed ids into rows, and drops ones the library has not synced', () => {
    // "Ids the library has not synced yet simply drop out" - a shelf must not
    // carry a hole where a song has not arrived.
    const { result } = renderHook(() => useHomeFeed(library, null));
    expect(result.current.resolve([1, 999, 2]).map((t) => t.path)).toEqual(['afm://1', 'afm://2']);
    expect(result.current.resolve(undefined)).toEqual([]);
  });

  it('resolves the collector auditions the library deliberately keeps out', async () => {
    /*
     * `forYou` is not in `tracks` on purpose - unadopted auditions must not pad
     * anybody's album counts or searches. But the curator builds this
     * listener's own pulls into its lists, so without them "a list of brand
     * new downloads resolved to nothing, fell under the four-track floor, and
     * the shelf vanished rather than showing the very thing it had just been
     * taught to build."
     */
    const auditions = [track(101), track(102), track(103), track(104)];
    const { result } = await feed({
      forYou: auditions,
      curator: { lists: [curatedList('pulls', { trackIds: [101, 102, 103, 104] })] },
    });
    await waitFor(() => expect(result.current.allCurated).toHaveLength(1));
    expect(result.current.allCurated[0]?.tracks).toHaveLength(4);
  });

  it('only resolves through THIS hub, so switching servers re-points the map', async () => {
    // `tracksOfHub` filters by origin; a path tagged for another hub is not
    // this hub's song.
    const mixed = [track(1), { ...track(2), path: 'afm://2@aHR0cDovL290aGVy' } as Track];
    const { result } = renderHook(() => useHomeFeed(mixed, session));
    expect(result.current.resolve([1, 2]).map((t) => t.path)).toEqual(['afm://1']);
  });
});

describe('the daylist and its two clocks', () => {
  /**
   * Freeze the wall clock at a UTC instant, with the local zone left alone.
   *
   * `toFake: ['Date']` and nothing else: the hook's effects and Testing
   * Library's `waitFor` both run on real timers, and faking those as well
   * deadlocks the wait against a clock only the test can advance.
   */
  const at = (iso: string) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(iso));
  };

  const fourCards = {
    lists: [0, 1, 2, 3].map((n) => curatedList(`daylist-${n}`, { name: `card ${n}` })),
    status: { ai: false },
  };

  it('CHOOSES THE CARD BY UTC, across all four quarter-days', async () => {
    // "MoodCluster.hours is UTC, so the card for right-now is simply the
    // current UTC bucket - no timezone arithmetic."
    for (const [iso, bucket] of [
      ['2026-09-08T02:00:00Z', 0],
      ['2026-09-08T08:00:00Z', 1],
      ['2026-09-08T14:00:00Z', 2],
      ['2026-09-08T20:00:00Z', 3],
    ] as const) {
      at(iso);
      const { result, unmount } = await feed({ curator: fourCards });
      await waitFor(() => expect(result.current.daylist).not.toBeNull());
      expect(result.current.daylist?.subtitle).toBe(`card ${bucket}`);
      unmount();
      vi.useRealTimers();
    }
  });

  it('WORDS IT BY THE LOCAL CLOCK, which is a different question', async () => {
    /*
     * The card says which four-hour slice of the server's day this is; the
     * heading says what the listener would call the time where they are.
     * Collapsing the two into one clock is the tidy-up that breaks this.
     */
    at('2026-09-08T08:00:00Z');
    const { result } = await feed({ curator: fourCards });
    await waitFor(() => expect(result.current.daylist).not.toBeNull());
    const now = new Date();
    const parts = ['home.daypartNight', 'home.daypartMorning', 'home.daypartAfternoon', 'home.daypartEvening'];
    expect(result.current.daylist?.title).toContain(parts[Math.floor(now.getHours() / 6)]!);
    vi.useRealTimers();
  });

  it('puts the weekday in as a HOLE the translator can move', async () => {
    // "'Tuesday morning' is two words in this order in English and neither of
    // those is true everywhere, so the day goes in as a hole."
    at('2026-09-08T08:00:00Z');
    const { result } = await feed({ curator: fourCards });
    await waitFor(() => expect(result.current.daylist).not.toBeNull());
    expect(result.current.daylist?.title).toMatch(/^home\.daypart\w+:\{"weekday":"[^"]+"\}$/);
    vi.useRealTimers();
  });

  it('is null when the card for right now is missing', async () => {
    at('2026-09-08T02:00:00Z');
    const { result } = await feed({
      curator: { lists: [curatedList('daylist-2')], status: { ai: false } },
    });
    await waitFor(() => expect(result.current.allCurated).toHaveLength(1));
    expect(result.current.daylist).toBeNull();
    vi.useRealTimers();
  });

  it('is null when the card for right now is too thin to play', async () => {
    at('2026-09-08T02:00:00Z');
    const { result } = await feed({
      curator: { lists: [curatedList('daylist-0', { trackIds: [1, 2, 3] })], status: { ai: false } },
    });
    expect(result.current.daylist).toBeNull();
    vi.useRealTimers();
  });
});

describe('the shelf split', () => {
  const lists = {
    lists: [
      curatedList('station-latenight', { name: 'Late Night' }),
      curatedList('daily-1', { name: 'Daily Mix 1' }),
      curatedList('mood-chill', { name: 'Chill' }),
      curatedList('daylist-0', { name: 'daylist card' }),
      curatedList('deep-cuts', { name: 'Deep Cuts' }),
    ],
    status: { ai: false },
  };

  it('sends stations to their own shelf', async () => {
    // "a mix is your own music arranged, a station is a place that also plays
    // you things you have never heard."
    const { result } = await feed({ curator: lists });
    await waitFor(() => expect(result.current.allCurated).toHaveLength(5));
    expect(result.current.stations.map((l) => l.title)).toEqual(['Late Night']);
  });

  it('sends daily and mood mixes to "Made for you"', async () => {
    const { result } = await feed({ curator: lists });
    await waitFor(() => expect(result.current.allCurated).toHaveLength(5));
    expect(result.current.madeForYouShelf.map((l) => l.title).sort()).toEqual(['Chill', 'Daily Mix 1']);
  });

  it('leaves EVERYTHING ELSE in "Made from your library", daylists excluded', async () => {
    // A daylist surfaces only as the single live lead card, never as a shelf
    // entry - so all four prefixes are excluded here, not three.
    const { result } = await feed({ curator: lists });
    await waitFor(() => expect(result.current.allCurated).toHaveLength(5));
    expect(result.current.curated.map((l) => l.title)).toEqual(['Deep Cuts']);
  });

  it('and the splits together account for every curated list exactly once', async () => {
    /*
     * The partition property, which no single one of the tests above can see.
     * `curated` is defined as a set of NOTs against the other three, so a
     * fifth prefix added to one filter and not to that list would show up here
     * as a list on two shelves, or on none.
     *
     * The daylist is the one deliberate exception: it is excluded from every
     * shelf and surfaces only as the lead card, so it is counted separately.
     */
    const { result } = await feed({ curator: lists });
    await waitFor(() => expect(result.current.allCurated).toHaveLength(5));
    const { stations, madeForYouShelf, curated, allCurated } = result.current;
    const shelved = [...stations, ...madeForYouShelf, ...curated].map((l) => l.id);
    expect(new Set(shelved).size).toBe(shelved.length);
    const daylists = allCurated.filter((l) => l.id.startsWith('curated-daylist-')).map((l) => l.id);
    expect([...shelved, ...daylists].sort()).toEqual(allCurated.map((l) => l.id).sort());
  });

  it('drops a curated list that does not resolve to four tracks', async () => {
    const { result } = await feed({
      curator: {
        lists: [curatedList('thin', { trackIds: [1, 2, 3] }), curatedList('fat')],
        status: { ai: false },
      },
    });
    await waitFor(() => expect(result.current.allCurated).toHaveLength(1));
    expect(result.current.allCurated[0]?.id).toBe('curated-fat');
  });

  it('marks curated lists ai or heuristic from the curator status', async () => {
    const { result } = await feed({
      curator: { lists: [curatedList('x')], status: { ai: true } },
    });
    await waitFor(() => expect(result.current.allCurated).toHaveLength(1));
    expect(result.current.allCurated[0]?.flavor).toBe('ai');
  });
});

describe('the "Made for you" dedupe', () => {
  it('shows a home-feed mix only when no curated list already said it', async () => {
    // "the curator's own lists first (they are built from a longer look at the
    // library), deduped by title so a mix that both halves produced appears
    // once."
    const { result } = await feed({
      home: { mixes: [{ id: 'm1', title: 'Deep Cuts', blurb: '', flavor: 'ai', trackIds: [1, 2, 3, 4] }] },
      curator: { lists: [curatedList('deep', { name: 'Deep Cuts' })], status: { ai: false } },
    });
    await waitFor(() => expect(result.current.madeForYou.length).toBeGreaterThan(0));
    expect(result.current.madeForYou).toHaveLength(1);
    expect(result.current.madeForYou[0]?.curated).toBe(true);
  });

  it('compares titles case- and space-insensitively', async () => {
    const { result } = await feed({
      home: { mixes: [{ id: 'm1', title: '  deep cuts ', blurb: '', flavor: 'ai', trackIds: [1, 2, 3, 4] }] },
      curator: { lists: [curatedList('deep', { name: 'Deep Cuts' })], status: { ai: false } },
    });
    await waitFor(() => expect(result.current.madeForYou.length).toBeGreaterThan(0));
    expect(result.current.madeForYou).toHaveLength(1);
  });

  it('SEEDS THE SET from the other two shelves, so a card cannot appear twice', async () => {
    /*
     * The daily/mood lists and the daylist used to live in `curated` and
     * seeded this set as a side effect; now that they are split off the seed
     * is explicit, "so the AI path (which can emit a 'Chill'/'Daily Mix
     * N'-titled mix) cannot double a card across two shelves."
     */
    const { result } = await feed({
      home: {
        mixes: [
          { id: 'm1', title: 'Chill', blurb: '', flavor: 'ai', trackIds: [1, 2, 3, 4] },
          { id: 'm2', title: 'Something Else', blurb: '', flavor: 'ai', trackIds: [1, 2, 3, 4] },
        ],
      },
      curator: { lists: [curatedList('mood-chill', { name: 'Chill' })], status: { ai: false } },
    });
    await waitFor(() => expect(result.current.madeForYou.length).toBeGreaterThan(0));
    expect(result.current.madeForYou.map((m) => m.mix.title)).toEqual(['Something Else']);
  });

  it('keeps a home-feed mix nothing else claimed', async () => {
    // The third case: the dedupe is not "curated always wins and mixes never
    // show".
    const { result } = await feed({
      home: { mixes: [{ id: 'm1', title: 'Rainy', blurb: '', flavor: 'ai', trackIds: [1, 2, 3, 4] }] },
    });
    await waitFor(() => expect(result.current.madeForYou.length).toBeGreaterThan(0));
    expect(result.current.madeForYou.map((m) => [m.mix.title, m.curated])).toEqual([['Rainy', false]]);
  });

  it('drops a home-feed mix that resolves to fewer than four tracks', async () => {
    const { result } = await feed({
      home: { mixes: [{ id: 'm1', title: 'Thin', blurb: '', flavor: 'ai', trackIds: [1, 2] }] },
    });
    expect(result.current.mixes).toEqual([]);
  });
});

describe('signed out', () => {
  it('makes a "fresh" shelf out of the library\'s own newest', async () => {
    // "Signed out there is no feed; the library's own newest still make a
    // shelf" - newest first, capped at 24.
    const many = Array.from({ length: 40 }, (_, i) => track(i + 1));
    const { result } = renderHook(() => useHomeFeed(many, null));
    expect(result.current.fresh).toHaveLength(24);
    expect(result.current.fresh[0]?.path).toBe('afm://40');
  });

  it('does not sort the caller\'s array in place', () => {
    const many = [track(1), track(3), track(2)];
    renderHook(() => useHomeFeed(many, null));
    expect(many.map((t) => t.path)).toEqual(['afm://1', 'afm://3', 'afm://2']);
  });

  it('asks the server for nothing at all', () => {
    renderHook(() => useHomeFeed(library, null));
    expect(fetchHome).not.toHaveBeenCalled();
    expect(fetchCurator).not.toHaveBeenCalled();
  });

  it('shows no skeletons, because there are no feeds to wait for', () => {
    const { result } = renderHook(() => useHomeFeed(library, null));
    expect(result.current.anySkeleton).toBe(false);
  });
});

describe('skeletons and the cached first paint', () => {
  it('seeds both feeds from the last launch, so shelves paint at full size', () => {
    // "the page must never assemble itself in front of the listener twice."
    readFeedCache.mockImplementation(((_s: unknown, which: string) =>
      which === 'home' ? { ...emptyHome, recent: [1, 2] } : { lists: [], status: { ai: false } }) as never);
    const { result } = renderHook(() => useHomeFeed(library, session));
    expect(result.current.recent.map((t) => t.path)).toEqual(['afm://1', 'afm://2']);
    expect(result.current.anySkeleton).toBe(false);
  });

  it('holds a skeleton on a first launch with nothing cached', () => {
    const { result } = renderHook(() => useHomeFeed(library, session));
    expect(result.current.skelFeed).toBe(true);
    expect(result.current.skelCurator).toBe(true);
  });

  it('keeps the curator skeleton up when only the home feed has answered', async () => {
    // "a feed that has not answered keeps its own skeleton, so a slow reply
    // swaps in place instead of popping the page."
    const { result } = await feed({ curator: null });
    // Three seconds against a one-second hold, and the margin is the point:
    // the first-launch beat is a real 1000ms timer, and waitFor's own default
    // is also 1000ms, so the two finish together and which one wins is down
    // to how loaded the machine is. Green on a laptop, red on a CI runner,
    // and nothing to do with the behaviour under test.
    await waitFor(() => expect(result.current.skelFeed).toBe(false), { timeout: 3000 });
    expect(result.current.curator).toBeNull();
  });

  it('writes each answer back to the cache for the next launch', async () => {
    await feed({});
    await waitFor(() => expect(writeFeedCache).toHaveBeenCalledWith(session, 'home', expect.anything()));
    expect(writeFeedCache).toHaveBeenCalledWith(session, 'curator', expect.anything());
  });

  it('keeps what is on screen when the refresh cannot reach the hub', async () => {
    readFeedCache.mockImplementation(((_s: unknown, which: string) =>
      which === 'home' ? { ...emptyHome, recent: [1] } : null) as never);
    fetchHome.mockRejectedValue(new Error('offline'));
    fetchCurator.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useHomeFeed(library, session));
    await waitFor(() => expect(fetchHome).toHaveBeenCalled());
    expect(result.current.recent.map((t) => t.path)).toEqual(['afm://1']);
  });
});

describe('the remaining shelves', () => {
  it('keeps each Jump-back-in album as its own ordered list', async () => {
    // "no name matching, no way to merge two albums that share a title."
    const { result } = await feed({ home: { jumpBackIn: [[3, 1, 2], [4, 5]], recent: [] } });
    await waitFor(() => expect(result.current.jumpBack).toHaveLength(2));
    expect(result.current.jumpBack[0]?.map((t) => t.path)).toEqual(['afm://3', 'afm://1', 'afm://2']);
  });

  it('drops an album none of whose tracks are synced', async () => {
    const { result } = await feed({ home: { jumpBackIn: [[900, 901], [1]] } });
    await waitFor(() => expect(result.current.jumpBack).toHaveLength(1));
  });

  it('gives a top artist a cover from the first of their tracks that has one', async () => {
    const tracks = [
      track(1, { artist: 'Radiohead' }),
      track(2, { artist: 'Radiohead', artwork: 'https://hub.test/art/a' }),
    ];
    fetchHome.mockResolvedValue({ ...emptyHome, topArtists: ['Radiohead', 'Nobody'] });
    fetchCurator.mockResolvedValue({ lists: [], status: { ai: false } });
    const { result } = renderHook(() => useHomeFeed(tracks, session));
    await waitFor(() => expect(result.current.topArtists).toHaveLength(1));
    expect(result.current.topArtists[0]).toEqual({ name: 'Radiohead', cover: 'https://hub.test/art/a' });
  });

  it('drops an artist the library does not actually hold', async () => {
    fetchHome.mockResolvedValue({ ...emptyHome, topArtists: ['Nobody'] });
    fetchCurator.mockResolvedValue({ lists: [], status: { ai: false } });
    const { result } = renderHook(() => useHomeFeed(library, session));
    await waitFor(() => expect(fetchHome).toHaveBeenCalled());
    expect(result.current.topArtists).toEqual([]);
  });

  it('calls the page quiet only when every history shelf is empty', async () => {
    const quiet = await feed({});
    await waitFor(() => expect(quiet.result.current.quiet).toBe(true));

    const loud = await feed({ home: { recent: [1] } });
    await waitFor(() => expect(loud.result.current.recent).toHaveLength(1));
    expect(loud.result.current.quiet).toBe(false);
  });
});
