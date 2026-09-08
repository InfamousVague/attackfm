/**
 * The feeds Discover, Home and Music Date read - stubbed, and owned here.
 *
 * The shared harness deliberately stops at the hub-side world: it stands up a
 * real server with a real library, and everything a listener SAVED is real
 * from end to end. What the machine MADE is not, and cannot be. A fresh hub's
 * `/api/home` has no history to read back, `/api/curator` has built no lists,
 * `/api/new-music` and `/api/trending` are empty until a harvest that wants
 * the internet, and `/api/date/candidates` is empty until a collector has been
 * shopping. Measured on the harness's own world, all five answer 200 with
 * nothing in them - which is a legitimate state the suites also assert on, and
 * a useless one to test a shelf with.
 *
 * So the payloads live here, in one file, in the shapes the client's own types
 * declare - `HomeFeed` (src/app/api/feed.ts), `CuratorFeed` and
 * `PreviewDateCard` (api/curator.ts), `NewMusicList` (api/newMusic.ts),
 * `TrendingFeed` (api/trending.ts), `RemoteTrack` (api/library.ts). They are
 * MIRRORED rather than imported: those modules pull in `import.meta.env` and
 * the app's own window globals through their import chain, and
 * `tsconfig.e2e.json` types the harness as Node, so an import of them fails to
 * compile. A shape change is still one edit - here - and the interfaces name
 * the file they came from so the two can be diffed by eye.
 *
 * Two rules this file exists to enforce, beyond convenience:
 *
 *   NOTHING REACHES THE INTERNET. `/api/discover` on the real hub answers with
 *   live Deezer chart rows (measured: it returns real cover URLs on
 *   cdn-images.dzcdn.net), and `/api/canvas` asks Spotify. A suite that
 *   scrolls Discover to its foot would fetch both. Both are stubbed by
 *   default, empty, whether a spec asks for them or not.
 *
 *   NOTHING WRITES TO THE SHARED HUB. One hub serves every suite in the run,
 *   in order, and a Music Date pass posts `/api/date/verdict`, which records a
 *   verdict and asks the server to discard the audition behind it. It is safe
 *   on a fixture track (`discard_audition` refuses anything that is not really
 *   an audition - see collector.rs), and it still leaves rows in a database
 *   the next suite inherits. The three date write routes are stubbed by
 *   default too, and counting their calls is how the suites assert a verdict
 *   was told to the server at all.
 */
import type { Page, Route } from '@playwright/test';
import type { HubApi } from './hub.ts';
import type { World } from './world.ts';

// --- the payloads ----------------------------------------------------------

/** Mirrors `HomeFeed`, src/app/api/feed.ts. */
export interface HomePayload {
  recent: number[];
  heavy: number[];
  heavyPlays: { id: number; plays: number }[];
  fresh: number[];
  /** Recently-played albums, each a full ordered track-id list. */
  jumpBackIn: number[][];
  topArtists: string[];
  mixes: { id: string; title: string; blurb: string; trackIds: number[]; flavor: 'ai' | 'heuristic' }[];
  ai: boolean;
}

/** Mirrors `CuratedList`, src/app/api/curator.ts. */
export interface CuratedPayload {
  slug: string;
  name: string;
  blurb: string;
  trackIds: number[];
  builtAt: number;
}

/** Mirrors `CuratorFeed`, src/app/api/curator.ts. */
export interface CuratorPayload {
  lists: CuratedPayload[];
  status: { phase: string; lastCurated: number; ai: boolean; chat: boolean; embeddings: boolean };
  progress: { checked: number; withTempo: number; withLyrics: number; total: number };
}

/** Mirrors `CollectorStatus`, src/app/api/curator.ts - `/api/curator/pulls`. */
export interface PullsPayload {
  userId: number;
  enabled: boolean;
  halted: 'cap' | null;
  ledgerBytes: number;
  capBytes: number;
  exploration: number;
  importable: boolean;
  delegates: boolean;
  downloadsHere: boolean;
  peerSeenAt: number | null;
  landedToday: number;
  recent: unknown[];
}

/** Mirrors `NewMusicTrack`, src/app/api/newMusic.ts. */
export interface NewMusicTrackPayload {
  id: string;
  title: string;
  artist: string;
  cover: string;
  url: string;
  preview: string;
  seed: string;
  bpm: number | null;
  lyricsRead: boolean;
  score: number;
}

/** Mirrors `NewMusicList`. The hub wraps these in `{ playlists: [...] }`. */
export interface NewMusicPayload {
  id: string;
  title: string;
  blurb: string;
  items: NewMusicTrackPayload[];
}

/** Mirrors `TrendItem`, src/app/api/trending.ts. */
export interface TrendItemPayload {
  extId: string;
  title: string;
  artist: string;
  cover: string;
  url: string;
  preview: string;
  seed: string;
  lane: string;
  score: number;
  rank: number | null;
  rankDelta: number | null;
  anchors: { artist: string; kind: string; strength: number }[];
  measured: { tempo: boolean; lyrics: boolean; texture: boolean };
}

/** Mirrors `TrendingFeed`. Each shelf is rendered under the label sent here. */
export interface TrendingPayload {
  global: { id: string; label: string; items: TrendItemPayload[] };
  scene: { id: string; label: string; items: TrendItemPayload[] };
  friends: {
    id: string;
    label: string;
    names: string[];
    items: { trackId: number; listeners: string[]; completions: number; lastAt: number }[];
  };
}

/** Mirrors `PreviewDateCard`, src/app/api/curator.ts. */
export interface PreviewCardPayload {
  extId: string;
  title: string;
  artist: string;
  cover: string;
  preview: string;
  seed: string;
  lane: string;
  bpm: number | null;
  popularity: number | null;
  score: number | null;
  measured: { tempo: boolean; lyrics: boolean; texture: boolean };
  released: string | null;
}

/** Mirrors `DateBriefingSong`. `voice` empty means the hub has no clips and
 *  the overlay paces its lines by reading time instead. */
export interface BriefingPayload {
  say: string;
  voice: string[];
}

// --- the builders ----------------------------------------------------------

/**
 * An empty home feed, plus whatever the caller cares about.
 *
 * Every field is present at its zero value rather than omitted, because the
 * hub always sends all of them and a shelf reading `feed?.recent` cannot tell
 * an absent field from an empty one - a stub that omits half the shape tests a
 * payload no server ever sends.
 */
export function homeFeed(over: Partial<HomePayload> = {}): HomePayload {
  return {
    recent: [],
    heavy: [],
    heavyPlays: [],
    fresh: [],
    jumpBackIn: [],
    topArtists: [],
    mixes: [],
    ai: false,
    ...over,
  };
}

/** One list as the curator writes them. The SLUG is load-bearing: the client
 *  splits its shelves on `curated-station-`, `curated-daily-`, `curated-mood-`
 *  and `curated-daylist-` prefixes (see useHomeFeed.ts), so a list's shelf is
 *  decided here and not by its name. */
export function curatedList(
  slug: string,
  name: string,
  trackIds: number[],
  blurb = '',
): CuratedPayload {
  return { slug, name, blurb, trackIds, builtAt: 1_700_000_000_000 };
}

export function curatorFeed(lists: CuratedPayload[], over: Partial<CuratorPayload> = {}): CuratorPayload {
  return {
    lists,
    status: { phase: 'idle', lastCurated: 1_700_000_000_000, ai: true, chat: true, embeddings: true },
    progress: { checked: 24, withTempo: 24, withLyrics: 24, total: 24 },
    ...over,
  };
}

/** The collector's ledger. `userId` decides which auditions are "mine" - a
 *  mismatch here is exactly how the Music Date chip once counted 767 songs the
 *  shelf beside it would not show (see library/myAuditions.ts). */
export function collectorStatus(userId: number, over: Partial<PullsPayload> = {}): PullsPayload {
  return {
    userId,
    enabled: true,
    halted: null,
    ledgerBytes: 0,
    capBytes: 250_000_000_000,
    exploration: 0.5,
    importable: true,
    delegates: false,
    downloadsHere: true,
    peerSeenAt: null,
    landedToday: 0,
    recent: [],
    ...over,
  };
}

export function newMusicTrack(over: Partial<NewMusicTrackPayload> = {}): NewMusicTrackPayload {
  return {
    id: 'dz:track:1',
    title: 'A Song Nobody Owns',
    artist: 'Somebody Else',
    cover: '',
    url: 'https://example.invalid/track/1',
    preview: '',
    seed: 'Nova Static',
    bpm: 118,
    lyricsRead: true,
    score: 0.8,
    ...over,
  };
}

export function newMusicList(
  id: string,
  title: string,
  items: NewMusicTrackPayload[],
  blurb = '',
): NewMusicPayload {
  return { id, title, blurb, items };
}

export function trendItem(over: Partial<TrendItemPayload> = {}): TrendItemPayload {
  return {
    extId: 'dz:track:900',
    title: 'Moving Right Now',
    artist: 'Chart Act',
    cover: '',
    url: 'https://example.invalid/track/900',
    preview: '',
    seed: 'Nova Static',
    lane: 'trending',
    score: 0.9,
    rank: 3,
    rankDelta: 4,
    anchors: [{ artist: 'Nova Static', kind: 'plays', strength: 0.8 }],
    measured: { tempo: true, lyrics: false, texture: false },
    ...over,
  };
}

export function trendingFeed(over: {
  global?: TrendItemPayload[];
  scene?: TrendItemPayload[];
  friends?: { trackId: number; listeners: string[]; completions: number; lastAt: number }[];
  names?: string[];
} = {}): TrendingPayload {
  return {
    global: { id: 'trend-global', label: 'Charts, filtered for you', items: over.global ?? [] },
    scene: { id: 'trend-scene', label: 'Rising in your scene', items: over.scene ?? [] },
    friends: {
      id: 'trend-friends',
      label: 'Friends on this hub',
      names: over.names ?? [],
      items: over.friends ?? [],
    },
  };
}

export function previewCard(over: Partial<PreviewCardPayload> = {}): PreviewCardPayload {
  return {
    extId: 'dz:track:5000',
    title: 'A Preview Date',
    artist: 'Unmet Act',
    cover: '',
    preview: '',
    seed: 'Nova Static',
    lane: 'taste',
    bpm: 120,
    popularity: 0.4,
    score: 0.7,
    measured: { tempo: true, lyrics: false, texture: false },
    released: '2025-04-01',
    ...over,
  };
}

// --- the router ------------------------------------------------------------

/** Every feed this file can answer for. The name is also the key `hold` and
 *  `asked` speak, so a spec never spells a path twice. */
export type FeedName =
  | 'home'
  | 'curator'
  | 'pulls'
  | 'newMusic'
  | 'trending'
  | 'wall'
  | 'canvas'
  | 'discover'
  | 'candidates'
  | 'preview'
  | 'briefing'
  | 'profiles'
  | 'verdict'
  | 'done'
  | 'candidateVerdict'
  | 'library';

/** Name -> the hub pathname it answers, matched EXACTLY. Exact rather than a
 *  prefix because `/api/curator` and `/api/curator/pulls` are two different
 *  feeds and a prefix match would silently hand one the other's payload. */
const PATHS: Record<FeedName, string> = {
  home: '/api/home',
  curator: '/api/curator',
  pulls: '/api/curator/pulls',
  newMusic: '/api/new-music',
  trending: '/api/trending',
  wall: '/api/wall/mine',
  canvas: '/api/canvas',
  discover: '/api/discover',
  candidates: '/api/date/candidates',
  preview: '/api/date/preview',
  briefing: '/api/date/briefing',
  profiles: '/api/date/profiles',
  verdict: '/api/date/verdict',
  done: '/api/date/done',
  candidateVerdict: '/api/date/candidate-verdict',
  library: '/api/library',
};

/**
 * What a stubbed feed answers with.
 *
 * A function is called per request and handed the URL, so an answer can depend
 * on what was asked - `/api/date/candidates?mode=tiny` and the same route with
 * no mode are two different decks, and a stub that could not tell them apart
 * could not test the labelled decks at all.
 */
export type Answer = unknown | ((url: URL) => unknown);

export interface FeedSpec {
  home?: Answer;
  curator?: Answer;
  pulls?: Answer;
  newMusic?: Answer;
  trending?: Answer;
  wall?: Answer;
  canvas?: Answer;
  discover?: Answer;
  candidates?: Answer;
  preview?: Answer;
  briefing?: Answer;
  profiles?: Answer;
  verdict?: Answer;
  done?: Answer;
  candidateVerdict?: Answer;
  /**
   * Turn library rows into the collector's unadopted auditions.
   *
   * The one thing that cannot be stubbed as a payload: an audition is an
   * ordinary library row wearing `curatorUserId`, and the client decides what
   * it is (`curatorUserId != null && !curatorPromoted` - library.tsx). So the
   * real `/api/library` answer is fetched, the named songs are marked, and the
   * page gets real ids, real art and real streamable bytes that the app then
   * treats as auditions. Anything else - a hand-written row - would be a
   * Music Date deck of songs that will not play.
   */
  auditions?: { titles: string[]; userId: number };
  /** Feeds that must not answer until `release` says so. */
  hold?: FeedName[];
}

export interface FeedStubs {
  /** Every hub `/api/...` pathname the page has asked for, in order, since
   *  the last `reset()`. Queries are dropped; `urls` keeps them. */
  readonly paths: string[];
  readonly urls: string[];
  /** How many times the page asked for this feed. */
  asked(name: FeedName): number;
  /** How many times it asked for a path this file does not stub. */
  askedPath(path: string): number;
  /** Every body posted to a stubbed feed, in order - what a verdict actually
   *  told the server, rather than merely that it told it something. */
  posted(name: FeedName): unknown[];
  /** Forget everything counted so far - the "and now open Discover" line. */
  reset(): void;
  /** Let a held feed answer. */
  release(name: FeedName): void;
  releaseAll(): void;
}

/** A promise somebody else resolves. */
function latch(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = () => resolve();
  });
  return { wait, open };
}

/**
 * Point the page's feeds at payloads this file owns, and start counting.
 *
 * Install it BEFORE the first `page.goto`: the shelves fetch on mount, and a
 * route registered afterwards would miss the very request the test is about.
 */
export async function installFeeds(page: Page, world: World, spec: FeedSpec = {}): Promise<FeedStubs> {
  const hubOrigin = new URL(world.hubUrl).origin;
  const paths: string[] = [];
  const urls: string[] = [];
  const posts: { name: FeedName; body: unknown }[] = [];

  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin !== hubOrigin || !url.pathname.startsWith('/api/')) return;
    paths.push(url.pathname);
    urls.push(url.pathname + url.search);
  });

  /*
   * `/api/discover` and `/api/canvas` are stubbed whether the spec mentions
   * them or not: both leave the machine (Deezer's chart rows and Spotify's
   * Canvas lookup), and a suite that reaches either has stopped being a test
   * of this app and started being a test of somebody's CDN.
   */
  const answers: Partial<Record<FeedName, Answer>> = {
    discover: { suggestions: [] },
    canvas: { url: null },
    ...spec,
  };

  const held = new Map<FeedName, ReturnType<typeof latch>>();
  for (const name of spec.hold ?? []) held.set(name, latch());

  const wanted = new Set<FeedName>(
    (Object.keys(answers) as FeedName[]).filter((n) => n in PATHS && answers[n] !== undefined),
  );
  if (spec.auditions) wanted.add('library');
  for (const name of held.keys()) wanted.add(name);

  const byPath = new Map<string, FeedName>();
  for (const name of wanted) byPath.set(PATHS[name], name);

  const settle = async (name: FeedName, route: Route): Promise<void> => {
    const gate = held.get(name);
    if (gate) await gate.wait;

    // Auditions are a REWRITE of the hub's own answer, not a payload.
    if (name === 'library' && spec.auditions) {
      const reply = await route.fetch();
      const body = (await reply.json()) as { tracks?: Array<Record<string, unknown>> };
      const mark = new Set(spec.auditions.titles);
      for (const row of body.tracks ?? []) {
        if (!mark.has(String(row.title))) continue;
        row.curatorUserId = spec.auditions.userId;
        row.curatorPromoted = false;
      }
      await route.fulfill({ response: reply, json: body });
      return;
    }

    const answer = answers[name];
    if (route.request().method() !== 'GET') {
      const raw = route.request().postData();
      if (raw !== null) {
        try {
          posts.push({ name, body: JSON.parse(raw) as unknown });
        } catch {
          posts.push({ name, body: raw });
        }
      }
    }
    // A feed named only in `hold` is held and then passed straight through, so
    // "this shelf is still waiting" can be tested against the real answer.
    if (answer === undefined) {
      await route.continue();
      return;
    }
    const url = new URL(route.request().url());
    await route.fulfill({
      json: typeof answer === 'function' ? (answer as (u: URL) => unknown)(url) : answer,
    });
  };

  await page.route(
    (url) => url.origin === hubOrigin && byPath.has(url.pathname),
    (route, request) => {
      const name = byPath.get(new URL(request.url()).pathname);
      if (!name) return void route.continue();
      void settle(name, route).catch(() => {
        // The page closed while a held feed was still waiting, which is the
        // ordinary end of a test that never released one.
      });
    },
  );

  const releaseAll = () => {
    for (const gate of held.values()) gate.open();
  };
  // A test that leaves a feed held must not leave the run hanging on it.
  page.once('close', releaseAll);

  return {
    paths,
    urls,
    asked: (name) => paths.filter((p) => p === PATHS[name]).length,
    askedPath: (path) => paths.filter((p) => p === path).length,
    posted: (name) => posts.filter((p) => p.name === name).map((p) => p.body),
    reset: () => {
      paths.length = 0;
      urls.length = 0;
      posts.length = 0;
    },
    release: (name) => held.get(name)?.open(),
    releaseAll,
  };
}

// --- odds and ends ---------------------------------------------------------

/**
 * The hub's own id for every song, by title.
 *
 * Feeds speak in library ids and the fixture manifest speaks in titles, so
 * every stub that names a real song goes through here. Read from the hub
 * rather than assumed: the ids are whatever the scanner assigned, in whatever
 * order it walked, and a suite that hard-codes 1..12 is a suite that breaks
 * the first time a record is added to the fixture library.
 */
export async function idsByTitle(hub: HubApi): Promise<Map<string, number>> {
  const rows = await hub.tracks();
  const out = new Map<string, number>();
  for (const row of rows) {
    const title = typeof row.title === 'string' ? row.title : null;
    const id = typeof row.id === 'number' ? row.id : null;
    if (title !== null && id !== null && !out.has(title)) out.set(title, id);
  }
  return out;
}

/** The ids of these songs, in the order named. Throws rather than silently
 *  dropping one - a feed with a hole in it makes a shelf that is short for a
 *  reason nobody can see. */
export function idsOf(byTitle: Map<string, number>, titles: string[]): number[] {
  return titles.map((title) => {
    const id = byTitle.get(title);
    if (id === undefined) throw new Error(`e2e: no fixture song called ${title}`);
    return id;
  });
}

/**
 * A playable URL for one fixture song, for a stub that has to hand the app
 * sound rather than a promise of it.
 *
 * A preview date whose clip does not resolve folds itself out of the deck
 * without a verdict (DatePage's `ensureSlot`), so a stubbed candidate with a
 * dead preview is a card that vanishes before it can be judged. This points
 * the clip at the hub's own stream, which is real bytes over real ranges, and
 * the hub answers `Access-Control-Allow-Origin: *` so the crossOrigin element
 * the date pool builds can read it.
 */
export function streamUrl(world: World, username: string, trackId: number): string {
  const user = world.users[username];
  if (!user) throw new Error(`e2e: no fixture account called ${username}`);
  return `${world.hubUrl}/api/stream/${trackId}?t=${encodeURIComponent(user.streamToken)}`;
}

/**
 * Turn the date briefing off for this device, before the bundle evaluates.
 *
 * Walking into Music Date normally raises a full-screen briefing overlay that
 * HOLDS the deck until the DJ has spoken (see DatePage's `intro`), which is
 * the listener's setting - Settings > AI > Music Date briefing - and is on by
 * default. Every scenario that is about the deck rather than about the
 * briefing turns it off the way the settings pane does, so the cards are there
 * on the first frame.
 */
export async function quietBriefing(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('attackfm-date-voice', 'off');
    } catch {
      // A store that refuses just means the overlay shows; the spec that
      // depends on it says so in its own wait.
    }
  });
}

/**
 * The cached feed answers this device is holding.
 *
 * `attackfm-cache-v<n>:<server>|<account>|<feed>` - and the version in the
 * middle is load-bearing: `core/coldStart.ts` sweeps exactly that shape on a
 * cold launch and must leave `attackfm-cache-deny` and `attackfm-cache-limit`,
 * which are state wearing a cache's name, alone.
 */
export async function feedCacheKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => Object.keys(localStorage).filter((k) => /^attackfm-cache-v\d+:/.test(k)));
}

/** The passed ledger this device is holding - Music Date's own memory across
 *  launches (`attackfm-date-passed`, see date/datePassed.ts). */
export async function passedLedger(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('attackfm-date-passed');
      return raw ? (JSON.parse(raw) as number[]) : [];
    } catch {
      return [];
    }
  });
}
