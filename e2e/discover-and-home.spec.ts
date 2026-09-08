/**
 * Discover and the shelves: the two pages a listener lands on.
 *
 * The split these scenarios keep honest is the one the app is built around -
 * the Library is what you SAVED or MADE, and Discover is everything the
 * machine has to say. Every shelf below is machine-made, so every shelf below
 * belongs on Discover; the Library's own page holds playlists, recently added
 * and liked songs and nothing else.
 *
 * All of it reads feeds a fresh hub cannot fill (no history to read back, no
 * curated lists, no harvest), so the feeds are stubbed - see
 * `fixtures/feeds.ts` for the payload shapes and for the two routes that would
 * otherwise leave the machine. Everything the feeds POINT AT is real: the ids
 * are the hub's own, the songs stream from it, and the art comes off the disk.
 */
// `test` and `expect` come from the harness, never from Playwright directly -
// the base ones have no idea where the app is. The Page TYPE is Playwright's.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/hub.ts';
import {
  collectorStatus,
  curatedList,
  curatorFeed,
  homeFeed,
  idsByTitle,
  idsOf,
  feedCacheKeys,
  installFeeds,
  newMusicList,
  newMusicTrack,
  trendItem,
  trendingFeed,
  type FeedSpec,
} from './fixtures/feeds.ts';

/** The nav's own Discover seat, rather than any button that says the word. */
const discoverSeat = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover', exact: true });

const librarySeat = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Library', exact: true });

/** The hero - one thing, big, wearing its music. See DiscoverHero.tsx. */
const hero = (page: Page) => page.getByTestId('discover-hero');

/**
 * A shelf, and a shelf's stand-in, told apart by `aria-busy`.
 *
 * Both wear `.homeShelf` on purpose - a skeleton is the same frame at the same
 * geometry, which is the whole reason nothing moves when the content lands -
 * so the heading alone cannot say which one is on screen. `aria-busy` is what
 * `ShelfSkeleton` already sets and what a screen reader is already told, so
 * the suite reads that rather than pinning anything new.
 */
const shelf = (page: Page, name: string) =>
  page
    .locator('section.homeShelf:not([aria-busy="true"])')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

const skeleton = (page: Page, name: string) =>
  page
    .locator('section[aria-busy="true"]')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

/** A feed set with nothing in it, which is what a fresh hub really answers. */
const bare: FeedSpec = {
  home: homeFeed(),
  curator: curatorFeed([]),
  newMusic: { playlists: [] },
  trending: trendingFeed(),
  wall: { canvases: [], covers: [] },
};

test.describe('Discover', () => {
  test('asks each of its feeds for exactly one answer', async ({ page, world, hub }) => {
    const byTitle = await idsByTitle(hub);
    const stubs = await installFeeds(page, world, {
      ...bare,
      home: homeFeed({ recent: idsOf(byTitle, ['Kindling', 'Copper Wire']) }),
      pulls: collectorStatus(world.userIds.matt!),
    });

    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    /*
     * From here, not from the boot: the bell's own discovery notices poll
     * `/api/new-music` and `/api/date/candidates` on a launch whatever page is
     * open (three and five minutes apart, so they never fire twice inside a
     * spec). Counting from the tap measures the MOUNT, which is what
     * `DiscoverFeedProvider` exists to make cheap: the page it replaced asked
     * for the home feed twice, the curator three times and the collector's
     * status twice, because no two shelves could see each other.
     */
    stubs.reset();
    await discoverSeat(page).click();
    await expect(hero(page)).toBeVisible();

    for (const feed of ['home', 'curator', 'pulls', 'newMusic', 'trending', 'wall'] as const) {
      await expect.poll(() => stubs.asked(feed), { timeout: 10_000 }).toBeGreaterThan(0);
    }
    // The page is fully assembled once its LAST shelf has taken its seat - the
    // catalogue suggestions, which hold a skeleton until they are scrolled to.
    await expect(page.getByRole('heading', { name: 'Suggested playlists' })).toBeVisible();

    expect({
      home: stubs.asked('home'),
      curator: stubs.asked('curator'),
      pulls: stubs.asked('pulls'),
      newMusic: stubs.asked('newMusic'),
      trending: stubs.asked('trending'),
      wall: stubs.asked('wall'),
    }).toEqual({ home: 1, curator: 1, pulls: 1, newMusic: 1, trending: 1, wall: 1 });

    // And the catalogue's own suggestions are NOT part of that mount: they are
    // the foot of a long page and wait until they are nearly in view.
    expect(stubs.asked('discover')).toBe(0);
  });

  test('leads with New for you, and opening it shows what is on it', async ({ page, world, hub }) => {
    const byTitle = await idsByTitle(hub);
    const stubs = await installFeeds(page, world, {
      ...bare,
      // A daylist is present and must LOSE: the newest thing the machine has
      // for you outranks the card that moves with the clock.
      curator: curatorFeed([curatedList('daylist-0', 'Small hours', idsOf(byTitle, ['Kindling', 'Copper Wire', 'Ember Days', 'Longhand']))]),
      newMusic: {
        playlists: [
          newMusicList('nm-warmth', 'Warmth, at a distance', [
            newMusicTrack({ id: 'dz:1', title: 'Paper Boats', artist: 'Half Light' }),
            newMusicTrack({ id: 'dz:2', title: 'Second Rain', artist: 'Half Light' }),
          ]),
        ],
      },
      pulls: collectorStatus(world.userIds.matt!),
    });

    await page.goto('/');
    await discoverSeat(page).click();

    await expect(hero(page).getByText('New for you', { exact: true })).toBeVisible();
    await expect(hero(page).getByRole('heading', { level: 1 })).toHaveText('Warmth, at a distance');

    // The lead is a list of songs nobody owns, so its verb is Open, never Play.
    await expect(hero(page).getByRole('button', { name: 'Play', exact: true })).toHaveCount(0);
    await hero(page).getByRole('button', { name: 'Open', exact: true }).click();

    const sheet = page.getByRole('dialog', { name: 'Warmth, at a distance' });
    await expect(sheet.getByText('Paper Boats')).toBeVisible();
    await expect(sheet.getByText('Second Rain')).toBeVisible();

    // A lead with a song has a face to ask about; the Canvas lookup is the
    // one request the library lead below must never make.
    await expect.poll(() => stubs.asked('canvas')).toBeGreaterThan(0);
  });

  test('falls to the daylist when there is nothing new, and the shelf does not show it twice', async ({
    page,
    world,
    hub,
  }) => {
    const byTitle = await idsByTitle(hub);
    const four = idsOf(byTitle, ['Kindling', 'Copper Wire', 'Ember Days', 'Longhand']);
    await installFeeds(page, world, {
      ...bare,
      curator: curatorFeed([
        curatedList('daylist-0', 'Small hours', four),
        curatedList('daylist-1', 'Morning pages', four),
        curatedList('daylist-2', 'Afternoon drift', four),
        curatedList('daylist-3', 'Evening amber', four),
        curatedList('daily-1', 'Daily Mix 1', four),
      ]),
      pulls: collectorStatus(world.userIds.matt!),
    });

    await page.goto('/');
    await discoverSeat(page).click();

    // The daylist lead is the only one that carries Play (a list lead carries
    // Open, the library lead neither), so this is the wait AND the assertion
    // that the fallback fired - and it has to come first: the hero leads with
    // the library until the curator's ids have resolved against the library,
    // which is a round trip after the tap.
    await expect(hero(page).getByRole('button', { name: 'Play', exact: true })).toBeVisible();

    // Which of the four the clock chose is the next test's business; that ONE
    // of them leads, and that the Made-for-you shelf below does not repeat it,
    // is this one's.
    const lead = await hero(page).getByRole('heading', { level: 1 }).innerText();
    expect(['Small hours', 'Morning pages', 'Afternoon drift', 'Evening amber']).toContain(lead);

    await expect(page.getByRole('heading', { name: 'Made for you' })).toBeVisible();
    await expect(page.getByText('Daily Mix 1')).toBeVisible();
    // Exactly once on the whole page: `daylistTaken` is what keeps the hero's
    // own card from appearing again an inch below it.
    await expect(page.getByText(lead, { exact: true })).toHaveCount(1);
  });

  test('leads with the library when there is neither, and never asks for a Canvas', async ({
    page,
    world,
  }) => {
    const stubs = await installFeeds(page, world, { ...bare });

    await page.goto('/');
    await discoverSeat(page).click();

    await expect(hero(page).getByRole('heading', { level: 1 })).toHaveText('Your library, read back to you');
    await expect(hero(page).getByRole('button', { name: 'All songs' })).toBeVisible();

    /*
     * The library lead has no first SONG - it is the whole library worn as a
     * mosaic - so there is nothing to ask a Canvas about. The hero asks for
     * one only once the wall has answered "no clips", which it has here
     * (`/api/wall/mine` returned an empty list), so a request now would be a
     * lookup for `undefined` going out to Spotify on every launch of every
     * fresh account.
     */
    await expect(page.getByRole('heading', { name: 'Suggested playlists' })).toBeVisible();
    expect(stubs.asked('canvas')).toBe(0);
  });

  test('the New-for-you shelf holds its skeleton until the feed answers, and lets go when it does', async ({
    page,
    world,
  }) => {
    const stubs = await installFeeds(page, world, {
      ...bare,
      newMusic: {
        playlists: [newMusicList('nm-late', 'Late transmissions', [newMusicTrack({ id: 'dz:9' })])],
      },
      hold: ['newMusic'],
    });

    await page.goto('/');
    await discoverSeat(page).click();

    // The seat is held at the right size under the right heading - the whole
    // reason the stand-in carries real text rather than a grey bar - and the
    // real shelf is not there yet.
    await expect(skeleton(page, 'New for you')).toBeVisible();
    await expect(shelf(page, 'New for you')).toHaveCount(0);

    stubs.release('newMusic');

    // And it lets go. A skeleton that never releases is the failure this
    // scenario is for: it looks exactly like a slow network forever.
    await expect(shelf(page, 'New for you').getByText('Late transmissions')).toBeVisible();
    await expect(skeleton(page, 'New for you')).toHaveCount(0);
  });

  test('a resume paints the shelves from the cache at full size, with the feeds still in flight', async ({
    page,
    world,
    hub,
  }) => {
    const byTitle = await idsByTitle(hub);
    const four = idsOf(byTitle, ['Kindling', 'Copper Wire', 'Ember Days', 'Longhand']);
    const feeds: FeedSpec = {
      ...bare,
      home: homeFeed({ recent: idsOf(byTitle, ['Margin Sketch', 'Ink and Weather']) }),
      curator: curatorFeed([curatedList('late-ledger', 'The Late Ledger', four)]),
      pulls: collectorStatus(world.userIds.matt!),
    };
    await installFeeds(page, world, feeds);

    await page.goto('/');
    await discoverSeat(page).click();
    await expect(shelf(page, 'Made from your library').getByText('The Late Ledger')).toBeVisible();

    /*
     * The same web view again, with both feeds held open.
     *
     * A reload is a RESUME - `sessionStorage` survives it, so `isColdStart`
     * says warm and the cold-start sweep leaves the feed caches alone (see
     * core/coldStart.ts). That is the case the cache exists for: a page whose
     * shelves come back only when the network does assembles itself in front
     * of the listener twice, skeletons and then a reflow as each shelf lands.
     * So with NOTHING answering, the shelves must already be there at full
     * size and no skeleton may be on screen at all.
     */
    await page.unrouteAll();
    const stubs = await installFeeds(page, world, { ...feeds, hold: ['home', 'curator'] });
    await page.reload();
    await discoverSeat(page).click();

    const made = shelf(page, 'Made from your library');
    await expect(made.getByText('The Late Ledger')).toBeVisible();
    await expect(shelf(page, 'Recently played').getByText('Margin Sketch')).toBeVisible();
    /*
     * Not `skeletons(page)` wholesale: the New-for-you shelf has no cache of
     * its own (the discovery pool is not a feed the cache keeps) and holds its
     * seat on every launch. These four are the ones the home and curator
     * caches seed, and not one of them may flash a stand-in on a resume.
     */
    for (const name of ['Made from your library', 'Jump back in', 'Your top artists', 'Recently played']) {
      await expect(skeleton(page, name)).toHaveCount(0);
    }

    const before = await made.boundingBox();
    stubs.release('home');
    stubs.release('curator');

    // The swap happens in place. Same content, same seat: if the cached paint
    // were thrown away and rebuilt, this row would move.
    await expect.poll(() => stubs.asked('curator')).toBeGreaterThan(0);
    await expect(made.getByText('The Late Ledger')).toBeVisible();
    const after = await made.boundingBox();
    expect(before).not.toBeNull();
    expect(after?.y).toBeCloseTo(before!.y, 0);
  });

  test('a cold start drops the cached feeds and nothing else', async ({ page, world, hub }) => {
    const byTitle = await idsByTitle(hub);
    const four = idsOf(byTitle, ['Kindling', 'Copper Wire', 'Ember Days', 'Longhand']);
    const feeds: FeedSpec = {
      ...bare,
      curator: curatorFeed([curatedList('late-ledger', 'The Late Ledger', four)]),
      pulls: collectorStatus(world.userIds.matt!),
    };
    await installFeeds(page, world, feeds);

    /*
     * `attackfm-cache-deny` is STATE wearing a cache's name: the songs this
     * device has been told never to keep. A cold start that swept the bare
     * `attackfm-cache` prefix reset it on every launch and resurrected songs
     * the listener had deleted, which is why the sweep is keyed to the
     * VERSIONED form. Seeded here so the sweep has both kinds to tell apart.
     */
    await page.addInitScript(() => {
      try {
        localStorage.setItem('attackfm-cache-deny', '["afm://7"]');
      } catch {
        // Storage refused; the assertion below will say so plainly.
      }
    });

    await page.goto('/');
    await discoverSeat(page).click();
    await expect(shelf(page, 'Made from your library').getByText('The Late Ledger')).toBeVisible();
    expect(await feedCacheKeys(page)).not.toHaveLength(0);

    // A NEW page is a new web view: no `attackfm-warm` marker, so the launch
    // reads as cold and the feeds are dropped rather than seeded stale.
    const cold = await page.context().newPage();
    // Both held, so the page cannot re-write what the sweep just dropped
    // before the assertion below can look.
    await installFeeds(cold, world, { ...feeds, hold: ['home', 'curator'] });
    await cold.goto('/');
    await discoverSeat(cold).click();

    await expect(skeleton(cold, 'Made from your library')).toBeVisible();
    expect((await feedCacheKeys(cold)).filter((k) => /\|(home|curator)$/.test(k))).toHaveLength(0);
    expect(await cold.evaluate(() => localStorage.getItem('attackfm-cache-deny'))).toBe('["afm://7"]');
    await cold.close();
  });

  test('a tap on a made-from-your-library tile opens the mix', async ({ page, world, hub }) => {
    const byTitle = await idsByTitle(hub);
    await installFeeds(page, world, {
      ...bare,
      curator: curatorFeed([
        curatedList(
          'quiet-hours',
          'Quiet hours',
          idsOf(byTitle, ['Margin Sketch', 'Ink and Weather', 'Ledger Line', 'Slate Rooftops']),
          'Four the curator put together.',
        ),
      ]),
      pulls: collectorStatus(world.userIds.matt!),
    });

    await page.goto('/');
    await discoverSeat(page).click();
    await page.getByRole('button', { name: /Quiet hours/ }).first().click();

    // The card opens the list as a PAGE - it does not play it - and the page
    // holds the four songs the feed's ids resolved to.
    await expect(page.getByRole('heading', { name: 'Quiet hours' })).toBeVisible();
    for (const song of ['Margin Sketch', 'Ink and Weather', 'Ledger Line', 'Slate Rooftops']) {
      await expect(page.getByText(song).first()).toBeVisible();
    }
  });

  test('a shelf whose ids this library does not hold is absent, not short', async ({ page, world, hub }) => {
    const byTitle = await idsByTitle(hub);
    const real = idsOf(byTitle, ['Kindling', 'Copper Wire', 'Ember Days']);
    await installFeeds(page, world, {
      ...bare,
      curator: curatorFeed([
        // Three songs this hub holds and one it does not. Every shelf resolves
        // its ids through the library's own map and drops what it cannot find,
        // which is right - and a curated list under four resolved songs is not
        // a list, so the whole card goes rather than a rail of three.
        curatedList('half-known', 'Half a list', [...real, 999_999]),
        curatedList('all-known', 'A whole list', [...real, byTitle.get('Longhand')!]),
      ]),
      pulls: collectorStatus(world.userIds.matt!),
    });

    await page.goto('/');
    await discoverSeat(page).click();

    await expect(page.getByText('A whole list')).toBeVisible();
    await expect(page.getByText('Half a list')).toHaveCount(0);
  });

  test("the collector's auditions show on Discover and never among the library's own songs", async ({
    page,
    world,
  }) => {
    const matt = world.userIds.matt!;
    await installFeeds(page, world, {
      ...bare,
      pulls: collectorStatus(matt),
      candidates: { candidates: [], total: 0 },
      // Two of the hub's own songs, wearing the collector's mark.
      auditions: { titles: ['Fountain Pen Blues', 'Longhand'], userId: matt },
    });

    await page.goto('/');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    /*
     * The library counts twelve songs; two of them are auditions, so it counts
     * ten. An audition is deliberately absent from the shelves, the search and
     * the table - it is not yours until a listen or a heart adopts it - and
     * this count is the cheapest place that rule is visible.
     */
    await expect(page.getByText('10 songs')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'New for you' })).toHaveCount(0);

    await discoverSeat(page).click();

    // On Discover they have their one home: the New-for-you shelf, each row
    // saying where it came from.
    const fresh = shelf(page, 'New for you');
    await expect(fresh.getByText('Fountain Pen Blues')).toBeVisible();
    await expect(fresh.getByText('Fetched for you').first()).toBeVisible();

    /*
     * And the Music Date chip counts THE SAME TWO. One definition for both
     * surfaces (library/myAuditions.ts): the chip once said 767 over a shelf
     * showing 220 because one filtered by owner and the other did not, and it
     * came back a second time saying "172 waiting" over an empty deck.
     */
    // `.first()`: the door is on the page twice by design - the card with the
    // big number under the hero, and a smaller seat on the People shelf - and
    // both must read the same number, so both are checked.
    const doors = page.getByRole('button', { name: 'Open Music Date' });
    await expect(doors).toHaveCount(2);
    await expect(doors.first()).toContainText('2 waiting, art and sound, no names');
    await expect(doors.last()).toContainText('2 waiting, art and sound, no names');
  });

  test('the Library holds only what you saved; every machine-made shelf is on Discover', async ({
    page,
    world,
    hub,
  }) => {
    const byTitle = await idsByTitle(hub);
    const four = idsOf(byTitle, ['Kindling', 'Copper Wire', 'Ember Days', 'Longhand']);
    await installFeeds(page, world, {
      ...bare,
      home: homeFeed({
        recent: idsOf(byTitle, ['Margin Sketch']),
        topArtists: ['Nova Static'],
        jumpBackIn: [idsOf(byTitle, ['Kindling', 'Copper Wire', 'Ember Days'])],
      }),
      curator: curatorFeed([curatedList('made-here', 'Made right here', four)]),
      trending: trendingFeed({ global: [trendItem({ title: 'Moving Right Now' })] }),
      pulls: collectorStatus(world.userIds.matt!),
    });

    // Every heading the machine writes. None of them may appear on the
    // Library; all of them must appear on Discover.
    const machine = [
      'Made from your library',
      'Jump back in',
      'Your top artists',
      'Recently played',
      'Charts, filtered for you',
    ];
    // What the Library is: what you saved, what you made, what you added.
    const yours = ['Recently added', 'Liked songs'];

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Recently added' })).toBeVisible();
    for (const heading of machine) {
      await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
    }

    await discoverSeat(page).click();
    for (const heading of machine) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }
    for (const heading of yours) {
      await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
    }

    // And back, so the split is a property of the two pages rather than of
    // the order they were opened in.
    await librarySeat(page).click();
    await expect(page.getByRole('heading', { name: 'Recently added' })).toBeVisible();
    for (const heading of machine) {
      await expect(page.getByRole('heading', { name: heading })).toHaveCount(0);
    }
  });
});

/**
 * The daylist, against a clock that does not move.
 *
 * The server has no timezone, so it writes FOUR cards keyed to UTC
 * quarter-days and the client picks the one for right now. The card is chosen
 * by the UTC bucket and the heading is worded from the LOCAL one - two
 * different clocks in one card, which is exactly the kind of arithmetic that
 * is right in the timezone the author lives in and wrong everywhere else.
 *
 * Kiritimati is UTC+14 and never observes daylight saving, so at four fixed
 * instants on a Tuesday the local reading is a different daypart each time -
 * and twice a different DAY, which is the case a test run in London would
 * never reach.
 */
test.describe('the daylist', () => {
  test.use({ timezoneId: 'Pacific/Kiritimati' });

  const quarters = [
    { at: '2026-03-03T01:00:00Z', card: 'Small hours', heading: 'Tuesday afternoon' },
    { at: '2026-03-03T07:00:00Z', card: 'Morning pages', heading: 'Tuesday evening' },
    { at: '2026-03-03T13:00:00Z', card: 'Afternoon drift', heading: 'Wednesday night' },
    { at: '2026-03-03T19:00:00Z', card: 'Evening amber', heading: 'Wednesday morning' },
  ];

  test('follows the clock across four UTC quarter-days, worded in local time', async ({
    page,
    world,
    hub,
  }) => {
    const byTitle = await idsByTitle(hub);
    const four = idsOf(byTitle, ['Kindling', 'Copper Wire', 'Ember Days', 'Longhand']);
    await installFeeds(page, world, {
      ...bare,
      curator: curatorFeed([
        curatedList('daylist-0', 'Small hours', four),
        curatedList('daylist-1', 'Morning pages', four),
        curatedList('daylist-2', 'Afternoon drift', four),
        curatedList('daylist-3', 'Evening amber', four),
      ]),
      pulls: collectorStatus(world.userIds.matt!),
    });

    for (const quarter of quarters) {
      // Fixed rather than installed: `setFixedTime` stops the clock without
      // taking the app's timers with it, and the daylist is recomputed off a
      // fresh Date on every render, so a reload is all it takes.
      await page.clock.setFixedTime(new Date(quarter.at));
      await page.goto('/');
      await discoverSeat(page).click();

      await expect(hero(page).getByRole('heading', { level: 1 })).toHaveText(quarter.card);
      await expect(hero(page).getByText(quarter.heading, { exact: true })).toBeVisible();
    }
  });
});

/**
 * The one scenario here that presses play, and it presses it AS KIM.
 *
 * The hub's Connect session is per ACCOUNT and outlives everything: once a
 * device has played, `hub.session` holds that track for the life of the
 * process, and a later suite's fresh device is told to `becomeActive` from it.
 * One hub serves this whole run in file order, so a play as `matt` here is
 * inherited by every spec that follows - including `smoke`, whose player then
 * boots holding a song parked at the end of its own duration and whose
 * unscoped `Play` locator can match the strip's button as well as the
 * library's. Measured: it turned the smoke into a coin flip, three runs in
 * three.
 *
 * `kim` has the same library and the same shelves, and nothing else in this
 * worktree plays as her, so the account this suite leaves holding a song is
 * one nobody downstream reads. The general fix is not mine to make - see the
 * report.
 */
test.describe('playing from a shelf', () => {
  test.use({ afmUser: 'kim' });

  test('a tap on a Recently played card plays that song', async ({ page, world, hub }) => {
    const byTitle = await idsByTitle(hub);
    await installFeeds(page, world, {
      ...bare,
      home: homeFeed({ recent: idsOf(byTitle, ['Signal Fade', 'Harbour Lights']) }),
      pulls: collectorStatus(world.userIds.kim!),
    });

    await page.goto('/');
    await discoverSeat(page).click();

    const played = shelf(page, 'Recently played');
    await expect(played).toBeVisible();
    await played.getByRole('button', { name: /Signal Fade/ }).first().click();

    const seek = page.getByRole('slider', { name: 'Seek' }).first();
    await expect(seek).toBeVisible();
    await expect(page.getByRole('button', { name: 'Pause' }).first()).toBeVisible();

    // Playing, not merely started: a 404 stream and a src that never loaded
    // both sit at zero forever.
    const started = Number(await seek.getAttribute('aria-valuenow'));
    await expect
      .poll(async () => Number(await seek.getAttribute('aria-valuenow')), { timeout: 15_000 })
      .toBeGreaterThan(started + 1);

    // Left at the top of the NEXT song and paused, so the state this account
    // carries forward is as close to nothing as the hub allows.
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'Pause' }).first().click();
    await expect.poll(async () => Number(await seek.getAttribute('aria-valuenow'))).toBe(0);
  });
});
