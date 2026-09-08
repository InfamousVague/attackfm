/**
 * Music Date, end to end: the door, the cards, the dock, and how it ends.
 *
 * The deck is the collector's unadopted auditions plus the pool's preview
 * candidates, and a fresh hub has neither - no collector has been shopping and
 * no harvest has run. So the pool half is stubbed outright, and the library
 * half is made the only way it can be made honestly: an audition is an
 * ordinary library row wearing `curatorUserId`, and the CLIENT decides what one
 * is, so the hub's own answer is fetched and four of its songs are marked (see
 * `fixtures/feeds.ts`). Everything after that is real - real ids, real art,
 * real bytes over real ranges, a real heart written to the hub.
 *
 * The three write routes are stubbed and counted rather than let through: one
 * hub serves every suite in this run and a pass asks it to discard the
 * audition behind the song. Counting the calls is also how these scenarios say
 * "and the server was told", which is the half of a verdict a screenshot
 * cannot show.
 *
 * Two things worth knowing before reading a wait below:
 *
 *   THE CARD SAYS NOTHING THE SUITE CAN COUNT ON. It wears a name now, but so
 *   does the card parked underneath it and so does the one flying off - three
 *   at once, two of them `aria-hidden`. The one unambiguous statement of "the
 *   song in your hand" is the verdict dock's own labels, "Keep {title}" and
 *   "Pass on {title}", which is also exactly what a screen reader is told. So
 *   that is what these scenarios read.
 *
 *   THE BRIEFING IS ON BY DEFAULT. Walking in raises a full-screen overlay
 *   that HOLDS the deck until the DJ has spoken. Every scenario that is about
 *   the deck turns it off the way the settings pane does; the two that are
 *   about the briefing leave it on.
 */
import type { Page } from '@playwright/test';
import { expect, test, type HubApi } from './fixtures/hub.ts';
import {
  collectorStatus,
  curatorFeed,
  homeFeed,
  installFeeds,
  passedLedger,
  previewCard,
  quietBriefing,
  streamUrl,
  trendingFeed,
  type FeedSpec,
  type FeedStubs,
} from './fixtures/feeds.ts';

/**
 * One song per record, so the deck's order is decided by something the harness
 * controls.
 *
 * `mine` is sorted newest-added first, and global-setup writes the library one
 * record at a time and lets the hub scan between them - so songs from
 * DIFFERENT records have reliably different `addedAt` and songs from the same
 * record can share a millisecond. Four records, four cards, in reverse of the
 * order they were written: Longhand, Ember Days, Blue Hour, Field Notes.
 */
const DECK = ['Margin Sketch', 'Slate Rooftops', 'Kindling', 'Fountain Pen Blues'];

/** The feeds every scenario here wants quiet, so Discover is one tap deep and
 *  nothing on it competes for the assertions. */
const quiet: FeedSpec = {
  home: homeFeed(),
  curator: curatorFeed([]),
  newMusic: { playlists: [] },
  trending: trendingFeed(),
  wall: { canvases: [], covers: [] },
  briefing: { songs: [] },
  profiles: { profiles: {} },
  verdict: { discarded: 0, freedBytes: 0 },
  done: { seeded: 0 },
  candidateVerdict: {},
};

const discoverSeat = (page: Page) =>
  page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Discover', exact: true });

/** The card with the big number, under the Discover hero. `.first()`: the
 *  People shelf carries a second, smaller seat to the same room. */
const dateDoor = (page: Page) => page.getByRole('button', { name: 'Open Music Date' }).first();

const keep = (page: Page) => page.getByRole('button', { name: /^Keep / });
const pass = (page: Page) => page.getByRole('button', { name: /^Pass on / });
const undo = (page: Page) => page.getByRole('button', { name: /^(Undo |Nothing to undo)/ });

/** Whose card is in your hand, read off the dock rather than off the art. */
async function current(page: Page): Promise<string> {
  const label = await keep(page).getAttribute('aria-label');
  return (label ?? '').replace(/^Keep /, '');
}

/** Stand up a page with a Music Date deck of `titles`, and walk into it. */
async function enterDate(
  page: Page,
  world: Parameters<typeof installFeeds>[1],
  spec: FeedSpec = {},
): Promise<FeedStubs> {
  await quietBriefing(page);
  const stubs = await installFeeds(page, world, {
    ...quiet,
    candidates: { candidates: [], total: 0 },
    pulls: collectorStatus(world.userIds.matt!),
    auditions: { titles: DECK, userId: world.userIds.matt! },
    ...spec,
  });
  await page.goto('/');
  await discoverSeat(page).click();
  await dateDoor(page).click();
  return stubs;
}

/**
 * Nothing this file hearts may outlive it.
 *
 * A keep is a real `PUT /api/favorites/{id}` on the hub every other suite in
 * the run shares, and a scenario that fails between the heart and the undo
 * would leave one behind for whoever runs next. Only the four songs this file
 * touches are cleared, so a favourite another suite set is not collateral.
 */
test.afterEach(async ({ hub }) => {
  const held = await hub.get<{ tracks: number[] }>('/api/favorites');
  const rows = await hub.tracks();
  const ours = new Set(
    rows.filter((r) => DECK.includes(String(r.title))).map((r) => Number(r.id)),
  );
  for (const id of held.tracks ?? []) {
    if (ours.has(id)) await hub.put(`/api/favorites/${id}`, { favorite: false });
  }
});

async function idOf(hub: HubApi, title: string): Promise<number> {
  const rows = await hub.tracks();
  const row = rows.find((r) => r.title === title);
  if (!row) throw new Error(`e2e: no fixture song called ${title}`);
  return Number(row.id);
}

test.describe('Music Date', () => {
  test("the chip's count is the deck: three passes drop it by exactly three", async ({ page, world }) => {
    await quietBriefing(page);
    await installFeeds(page, world, {
      ...quiet,
      candidates: { candidates: [], total: 0 },
      pulls: collectorStatus(world.userIds.matt!),
      auditions: { titles: DECK, userId: world.userIds.matt! },
    });
    await page.goto('/');
    await discoverSeat(page).click();

    /*
     * One definition, two surfaces. The chip counted every audition this
     * client had ever been sent and the shelf counted the ones that were
     * this listener's, and the same screen said 767 and 220; the second time
     * it was "172 waiting" over a deck that was already empty, because a
     * verdict was not a reason to stop counting a song. So: the number on the
     * door, then the number inside it, then the number on the door again.
     */
    await expect(dateDoor(page)).toContainText('4 waiting, art and sound, no names');
    await dateDoor(page).click();
    await expect(page.getByText('4 left to meet')).toBeVisible();

    for (let i = 0; i < 3; i += 1) {
      const card = await current(page);
      await pass(page).click();
      await expect.poll(() => current(page)).not.toBe(card);
    }

    await expect(page.getByText('1 left to meet')).toBeVisible();
    await expect(page.getByText('3 passed')).toBeVisible();
    await expect(page.getByText('0 kept')).toBeVisible();

    await page.getByRole('button', { name: 'Leave Music Date' }).click();
    await expect(dateDoor(page)).toContainText('1 waiting, art and sound, no names');
  });

  test('the card in your hand is wordless to the deck below it', async ({ page, world }) => {
    await enterDate(page, world);

    const card = await current(page);
    // Three cards are in the stack at once - the one under, the live one, the
    // one flying off - and only the live one may be spoken for. The dock's
    // label is the single statement of which song is being judged; the deck
    // itself carries the same name three times over if the stack is read as
    // text, which is why nothing here reads it that way.
    await expect(pass(page)).toHaveAccessibleName(`Pass on ${card}. Hold for less like this`);
    await expect(keep(page)).toHaveCount(1);
    await expect(pass(page)).toHaveCount(1);
    await expect(undo(page)).toHaveAccessibleName('Nothing to undo');
  });

  test('the swipe itself: a wobble is not a verdict, and the squiggle never judges', async ({
    page,
    world,
  }) => {
    await enterDate(page, world);
    const card = await current(page);

    /*
     * The card is a drag surface with no role and no name - it is a picture -
     * so the gesture is aimed rather than located: the snippet's squiggle is
     * the one labelled thing inside it, and a thumb's width above that is the
     * art. Nothing here pins a class name.
     */
    const wave = page.getByRole('slider', { name: 'Snippet position' });
    const bar = await wave.boundingBox();
    expect(bar).not.toBeNull();
    const from = { x: bar!.x + bar!.width / 2, y: bar!.y - 120 };

    const drag = async (start: { x: number; y: number }, dx: number) => {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x + dx, start.y, { steps: 8 });
      await page.mouse.up();
    };

    // Under the threshold the card comes back rather than being judged: 90px
    // is what separates a decision from a thumb resting on the screen.
    await drag(from, -40);
    expect(await current(page)).toBe(card);

    // A drag that STARTS on the squiggle is a seek, not a verdict. The card
    // reads the gesture and stands down, or a listener scrubbing the snippet
    // would pass on the song by accident.
    await drag({ x: bar!.x + bar!.width / 2, y: bar!.y + bar!.height / 2 }, -160);
    expect(await current(page)).toBe(card);

    // And past it, left, is a pass - the same verdict the dock's button makes.
    await drag(from, -160);
    await expect.poll(() => current(page)).not.toBe(card);
    await expect(page.getByText('1 passed')).toBeVisible();
    await expect.poll(() => passedLedger(page)).toHaveLength(1);
  });

  test('a pass survives a relaunch', async ({ page, world }) => {
    const stubs = await enterDate(page, world);

    const passed = await current(page);
    await pass(page).click();
    await expect.poll(() => current(page)).not.toBe(passed);

    // The pass is durable in two places at once, and both matter: this
    // device's ledger, so the deck moves on across launches, and the server,
    // so the next device does not deal the same card again.
    await expect.poll(() => passedLedger(page)).toHaveLength(1);
    await expect.poll(() => stubs.posted('verdict')).toContainEqual(
      expect.objectContaining({ kept: [], passed: [expect.any(Number)] }),
    );

    /*
     * A relaunch, with real storage - not the demo shim, which replaces
     * localStorage with a plain object and would remember nothing at all.
     */
    await page.reload();
    await discoverSeat(page).click();
    await expect(dateDoor(page)).toContainText('3 waiting, art and sound, no names');
    await dateDoor(page).click();

    await expect(page.getByText('3 left to meet')).toBeVisible();
    expect(await current(page)).not.toBe(passed);
    await expect.poll(() => passedLedger(page)).toHaveLength(1);
  });

  test('undoing a keep un-hearts the song and puts the card back', async ({ page, world, hub }) => {
    await enterDate(page, world);

    const kept = await current(page);
    const id = await idOf(hub, kept);

    await keep(page).click();
    await expect.poll(() => current(page)).not.toBe(kept);
    await expect(undo(page)).toHaveAccessibleName(`Undo keeping ${kept}`);
    await expect(page.getByText('1 kept')).toBeVisible();

    // The heart IS the adoption, and it reaches the hub - this is the one
    // verdict that changes something outside the browser.
    await expect
      .poll(async () => (await hub.get<{ tracks: number[] }>('/api/favorites')).tracks)
      .toContain(id);

    await undo(page).click();

    // Three filters hid that card and undo has to lift all of them: this
    // sitting's `gone` set, the favourite the keep created, and the deck's own
    // sort. Lifting only the first would look exactly like undo doing nothing.
    await expect.poll(() => current(page)).toBe(kept);
    await expect(page.getByText('0 kept')).toBeVisible();
    await expect(undo(page)).toHaveAccessibleName('Nothing to undo');
    await expect
      .poll(async () => (await hub.get<{ tracks: number[] }>('/api/favorites')).tracks)
      .not.toContain(id);
  });

  test('undoing a pass clears the ledger entry', async ({ page, world }) => {
    await enterDate(page, world);

    const passed = await current(page);
    await pass(page).click();
    await expect.poll(() => current(page)).not.toBe(passed);
    await expect.poll(() => passedLedger(page)).toHaveLength(1);

    await undo(page).click();

    /*
     * The persisted list is the filter that OUTLIVES the page, so an undo that
     * only forgot this sitting would put the card back now and lose it again
     * on the next launch. The ledger is the assertion; the card coming back is
     * only the symptom.
     */
    await expect.poll(() => passedLedger(page)).toHaveLength(0);
    await expect.poll(() => current(page)).toBe(passed);
    await expect(page.getByText('0 passed')).toBeVisible();
    await expect(page.getByText('4 left to meet')).toBeVisible();
  });

  test('two cards can be judged in a row without touching the screen', async ({ page, world }) => {
    await enterDate(page, world);

    /*
     * The verdict dock is a SIBLING of the three cards, not a child of the
     * live one, and this is the difference that cannot be styled around: the
     * live card is keyed on the song's path, so it UNMOUNTS inside the very
     * press being made on it. Nested, the button would go with it and focus
     * would land back on the document root after every verdict - a keyboard or
     * switch listener could not judge two cards in a row. Do not tidy the dock
     * into the card.
     */
    const first = await current(page);
    await keep(page).focus();
    await page.keyboard.press('Enter');

    await expect.poll(() => current(page)).not.toBe(first);
    const stillOnKeep = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? '');
    expect(stillOnKeep).toMatch(/^Keep /);

    await page.keyboard.press('Enter');
    await expect(page.getByText('2 kept')).toBeVisible();
    await expect(page.getByText('2 left to meet')).toBeVisible();
  });

  test('the deck runs dry, the page says so, and the sitting is told to the server once', async ({
    page,
    world,
    hub,
  }) => {
    const two = ['Kindling', 'Fountain Pen Blues'];
    await quietBriefing(page);
    const stubs = await installFeeds(page, world, {
      ...quiet,
      candidates: { candidates: [], total: 0 },
      pulls: collectorStatus(world.userIds.matt!),
      auditions: { titles: two, userId: world.userIds.matt! },
    });
    await page.goto('/');
    await discoverSeat(page).click();
    await dateDoor(page).click();

    const ids: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      ids.push(await idOf(hub, await current(page)));
      await pass(page).click();
      await expect.poll(() => keep(page).count()).toBe(i === 0 ? 1 : 0);
    }

    /*
     * The end of a Date is the moment the app knows most about what you want
     * and has the least left to show you, so it asks for more THEN rather than
     * waiting out the collector's six-hourly sweep. Once per emptying, seeded
     * by the verdicts just given - and the empty state is the promise being
     * kept, in words.
     */
    await expect(
      page.getByText('That’s everyone. Your server is out looking now — new ones land as it finds them.'),
    ).toBeVisible();

    /*
     * The LAST thing said, not the only thing: entering Music Date already
     * posts one `{kept: [], passed: []}` because the deck is empty for the
     * frame before the collector's status has answered and `mine` can be
     * computed - see the report. What this scenario is about is the sitting
     * that really happened, and it is reported once, whole, in swipe order.
     */
    expect(stubs.posted('done').at(-1)).toEqual({ kept: [], passed: ids });
    expect(stubs.posted('done').filter((body) => JSON.stringify(body) !== '{"kept":[],"passed":[]}')).toEqual([
      { kept: [], passed: ids },
    ]);
  });

  test('the passed ones can be met again, and the ledger lets them go', async ({ page, world }) => {
    const two = ['Kindling', 'Fountain Pen Blues'];
    await quietBriefing(page);
    await installFeeds(page, world, {
      ...quiet,
      candidates: { candidates: [], total: 0 },
      pulls: collectorStatus(world.userIds.matt!),
      auditions: { titles: two, userId: world.userIds.matt! },
    });
    await page.goto('/');
    await discoverSeat(page).click();
    await dateDoor(page).click();

    await pass(page).click();
    await expect.poll(() => keep(page).count()).toBe(1);
    await pass(page).click();
    await expect.poll(() => keep(page).count()).toBe(0);
    await expect.poll(() => passedLedger(page)).toHaveLength(2);

    // The way back out of a dead end. It empties the ledger, not just this
    // sitting - the cards were being hidden by the persisted list.
    await page.getByRole('button', { name: 'Meet the passed ones again' }).click();
    await expect.poll(() => passedLedger(page)).toHaveLength(0);
    await expect(keep(page)).toHaveCount(1);
    await expect(page.getByText('2 left to meet')).toBeVisible();
  });

  test('a preview date is judged through its own door, and cannot be undone', async ({ page, world, hub }) => {
    /*
     * Preview dates are what unchained the deck from the download queue: the
     * pool's best candidates, dealt on the catalogue's thirty seconds, none of
     * them on the box. A keep buys the song; a pass forgets the candidate. And
     * there is no undo, because the pool has already moved.
     *
     * The clip has to be REAL. A candidate whose preview does not resolve
     * folds itself out of the deck with no verdict at all (`ensureSlot`), so a
     * stubbed card with a dead clip is a card that disappears before it can be
     * judged - and a suite built on one would pass while testing nothing.
     */
    await quietBriefing(page);
    const stubs = await installFeeds(page, world, {
      ...quiet,
      pulls: collectorStatus(world.userIds.matt!),
      candidates: {
        candidates: [
          previewCard({ extId: 'dz:track:5001', title: 'Paper Boats', artist: 'Half Light' }),
          previewCard({ extId: 'dz:track:5002', title: 'Second Rain', artist: 'Half Light' }),
        ],
        total: 9,
      },
      // A real clip off this hub, which is real bytes over real ranges and
      // comes back with `Access-Control-Allow-Origin: *` - the date pool's
      // elements are `crossOrigin = 'anonymous'` and would not read it
      // otherwise.
      preview: { preview: streamUrl(world, 'matt', await idOf(hub, 'Kindling')) },
    });
    await page.goto('/');
    await discoverSeat(page).click();

    // The pool's depth counts on the door too, or the chip promises six while
    // the deck deals hundreds.
    await expect(dateDoor(page)).toContainText('9 waiting, art and sound, no names');
    await dateDoor(page).click();

    // Dealt two of nine: the seven the deal did not hand over are still ahead.
    await expect(page.getByText('9 left to meet')).toBeVisible();
    await expect(page.getByText('Preview').first()).toBeVisible();

    const card = await current(page);
    await pass(page).click();
    await expect.poll(() => current(page)).not.toBe(card);

    await expect.poll(() => stubs.posted('candidateVerdict')).toEqual([
      { extId: card === 'Paper Boats' ? 'dz:track:5001' : 'dz:track:5002', kept: false },
    ]);
    // No library path to hang a verdict on, so nothing to walk back to.
    await expect(undo(page)).toHaveAccessibleName('Nothing to undo');
    // And the pool's own route was used, not the library one.
    expect(stubs.asked('verdict')).toBe(0);
  });

  test('a labelled deck that deals nothing can always be left, and is not the end of a sitting', async ({
    page,
    world,
    hub,
  }) => {
    await quietBriefing(page);
    const stubs = await installFeeds(page, world, {
      ...quiet,
      pulls: collectorStatus(world.userIds.matt!),
      auditions: { titles: DECK, userId: world.userIds.matt! },
      preview: { preview: streamUrl(world, 'matt', await idOf(hub, 'Kindling')) },
      // The labelled decks are the server's answer to a DIFFERENT question, so
      // a mode is a different deal - and `tiny` has nothing for this listener,
      // which is an ordinary answer and not a failure.
      // The URL is annotated because `Answer` is deliberately `unknown` - a feed
      // answers with whatever shape its route sends - so there is nothing for
      // TypeScript to infer the parameter from.
      candidates: (url: URL) =>
        url.searchParams.get('mode')
          ? { candidates: [], total: 0 }
          : {
              candidates: [
                previewCard({ extId: 'dz:track:7001', title: 'Paper Boats', artist: 'Half Light' }),
                previewCard({ extId: 'dz:track:7002', title: 'Second Rain', artist: 'Half Light' }),
              ],
              total: 2,
            },
    });
    await page.goto('/');
    await discoverSeat(page).click();
    await dateDoor(page).click();
    // Four auditions and two of the pool's cards: the default deck is your
    // taste and nothing blended in, and both halves are that.
    await expect(page.getByText('6 left to meet')).toBeVisible();

    /*
     * In a mode the library half of the deck is set aside on purpose - a "tiny
     * artists" deck still leaking your old auditions would not be the deck it
     * says it is - so this mode is empty. The chips are rendered OUTSIDE the
     * populated/empty split for exactly this: without that, choosing a deck
     * with nothing in it would strand the listener with no control on screen.
     */
    const before = stubs.asked('done');
    await page.getByRole('button', { name: 'Tiny artists' }).click();
    await expect(
      page.getByText('No tiny artists left to meet right now - tap Tiny artists above to go back to everything.'),
    ).toBeVisible();

    /*
     * A flip empties the deck to RE-DEAL. That is not a finished sitting, so
     * the server must not be told one ended - the `switchingDeck` flag exists
     * for exactly this. A delta rather than a count, because entering the page
     * already posts one (see the report): what matters is that emptying the
     * deck by tapping a chip adds nothing to it.
     */
    expect(stubs.asked('done')).toBe(before);

    await page.getByRole('button', { name: 'Tiny artists' }).click();
    await expect(keep(page)).toHaveCount(1);
    await expect(page.getByText('6 left to meet')).toBeVisible();
    expect(stubs.asked('done')).toBe(before);
  });
});

/**
 * The briefing, which is the one thing that stands between the door and the
 * deck. Its own describe because these two leave it ON, and everything above
 * turns it off.
 */
test.describe('the date briefing', () => {
  test('holds the deck until the DJ has spoken, and Skip lets it go', async ({ page, world }) => {
    const stubs = await installFeeds(page, world, {
      ...quiet,
      candidates: { candidates: [], total: 0 },
      pulls: collectorStatus(world.userIds.matt!),
      auditions: { titles: DECK, userId: world.userIds.matt! },
      briefing: {
        songs: [
          { say: 'First up, an old friend of yours.', voice: [] },
          { say: 'Then something with a bit more nerve.', voice: [] },
          { say: 'And one you have never heard.', voice: [] },
        ],
      },
    });

    await page.goto('/');
    await discoverSeat(page).click();
    await dateDoor(page).click();

    const overlay = page.getByRole('dialog', { name: 'Your date briefing' });
    await expect(overlay).toBeVisible();
    await expect(overlay.getByText('First up, an old friend of yours.')).toBeVisible();
    await expect(overlay.getByText('And one you have never heard.')).toBeVisible();

    // The words are about the next THREE cards, named by the client because
    // the deck's order and filters live there and not on the server.
    const asked = stubs.urls.filter((u) => u.startsWith('/api/date/briefing'));
    expect(asked).toHaveLength(1);
    expect(new URL(asked[0]!, 'http://hub').searchParams.get('ids')?.split(',')).toHaveLength(3);

    await page.getByRole('button', { name: 'Skip intro' }).click();
    await expect(overlay).toHaveCount(0);
    await expect(keep(page)).toHaveCount(1);
  });

  test('a briefing that never answers lets the deck go anyway', async ({ page, world }) => {
    /*
     * A door that cannot open must not hold the room. The overlay opens on
     * `loading` before the hub has said anything, so a hub thinking for a long
     * time - or one that never answers - would otherwise leave a listener
     * looking at a blurred nothing with no way past it but the back button.
     * Six seconds, then the deck starts whatever the DJ is doing.
     */
    await installFeeds(page, world, {
      ...quiet,
      candidates: { candidates: [], total: 0 },
      pulls: collectorStatus(world.userIds.matt!),
      auditions: { titles: DECK, userId: world.userIds.matt! },
      hold: ['briefing'],
    });

    await page.goto('/');
    await discoverSeat(page).click();
    await dateDoor(page).click();

    await expect(page.getByRole('dialog', { name: 'Your date briefing' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Your date briefing' })).toHaveCount(0, { timeout: 15_000 });
    await expect(keep(page)).toHaveCount(1);
    await expect(page.getByText('4 left to meet')).toBeVisible();
  });
});
