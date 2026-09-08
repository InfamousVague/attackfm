/**
 * The groove: friends on one host's clock.
 *
 * Two browsers throughout, both real, both against the real hub - because the
 * whole feature is what happens BETWEEN two devices and none of it exists in
 * one. The failures this repo has actually shipped and then fixed are the
 * shape of the assertions here: a follower's poll that dropped a member's
 * send, a next-send that did nothing, a room that read as "failed" when it had
 * merely ended, a device claiming a seat it did not hold.
 *
 * Both contexts sit on 127.0.0.1, so the hub considers them on the same
 * network unconditionally - which makes the nearby offer deterministic and is
 * the door the guest walks through in most of these. (The *not*-nearby
 * negative would need `X-Forwarded-For` spoofing and is not reachable from a
 * browser; it is a hub test, not this suite's.)
 *
 * Every test opens its own room and `afterEach` closes whatever is left, since
 * one hub serves the whole run and a room left standing is a room the next
 * suite's first poll walks into.
 */
import { BEAT, contextAs, expect, settle, test, type World } from './fixtures/hub.ts';
import type { BrowserContext, Locator, Page } from '@playwright/test';
import {
  DEVICE,
  apiAs,
  asDevice,
  audioState,
  cards,
  closeRooms,
  fromTrackMenu,
  nowPlaying,
  openLibrary,
  seekAt,
  sheetTitle,
} from './fixtures/deck.ts';

/*
 * ana hosts, kim comes in - and neither of them is matt.
 *
 * A Connect seat outlives its context by thirty seconds (DEVICE in
 * fixtures/deck.ts has the reasoning), so a suite that plays music leaves the
 * account it used mirroring into whatever runs next. Keeping both of Agent
 * A's suites off matt leaves the harness's own smoke a quiet account to start
 * from, and sharing kim's device id with `player-deck` means kim is ONE device
 * across the pair rather than a newcomer watching her own previous seat.
 */
test.use({ afmUser: 'ana' });

const HOST = 'ana';
const HOST_DEVICE = DEVICE.ana;
const GUEST_DEVICE = DEVICE.kim;

/** The room's deck, and the glyph that opens it. Both wear the same accessible
 *  name - "Your groove - 2 listening", "In ana's groove - 2 listening" - so
 *  one pattern finds either. */
const deck = (page: Page, name: RegExp): Locator => page.getByRole('dialog', { name });
const deckGlyph = (page: Page, name: RegExp): Locator => page.getByRole('button', { name });

const HOSTING = /^Your groove/;
const FOLLOWING = /groove — \d+ listening/;

/** The deck dismisses on an outside press like any popover, so anything that
 *  touches the page behind it has to knock again. */
async function openDeck(page: Page, name: RegExp): Promise<Locator> {
  const panel = deck(page, name).first();
  if (!(await panel.isVisible().catch(() => false))) {
    await deckGlyph(page, name).first().click();
  }
  await expect(panel).toBeVisible();
  return panel;
}

/** Matt, playing something, with a room open - and the code on the card. */
async function startRoom(page: Page): Promise<string> {
  await openLibrary(page, HOST_DEVICE);
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(nowPlaying(page)).toBeVisible();

  await nowPlaying(page).getByRole('button', { name: 'Start a groove' }).click();
  await page.getByRole('button', { name: /^Start a groove:/ }).click();

  const code = page.locator('.jamInvite__mono').first();
  await expect(code).toBeVisible({ timeout: settle() });
  const printed = (await code.innerText()).trim();
  expect(printed).toMatch(/^[A-Z0-9]{4,}$/);

  // Put the panel down: it is a popover over the page, and every scenario
  // after this one wants the page.
  await page.keyboard.press('Escape');
  return printed;
}

/** A second person, signed in, on their own device, at the library. */
async function guest(
  browser: import('@playwright/test').Browser,
  world: World,
  who = 'kim',
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await contextAs(browser, world, who);
  const page = await context.newPage();
  await asDevice(page, GUEST_DEVICE);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  return { context, page };
}

/** Walk in through the offer the hub raises for a room on the same network,
 *  and answer the question it asks on the way. */
async function joinNearby(page: Page, host: string, hear: 'device' | 'speaker'): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^Join ${host}.s groove$`) }).click({ timeout: settle() });
  const where = hear === 'device' ? /^On this device/ : new RegExp(`^On ${host}.s speaker`);
  await page.getByRole('button', { name: where }).click({ timeout: settle() });
}

test.describe('a listening room', () => {
  test.afterEach(async ({ world }) => {
    await closeRooms(apiAs(world, 'matt'), apiAs(world, 'kim'), apiAs(world, 'ana'));
  });

  test('a host opens a room and the deck says whose it is', async ({ page }) => {
    const code = await startRoom(page);

    const panel = await openDeck(page, HOSTING);
    // The room reports ITSELF, not just the fact that a request succeeded: who
    // is in it, whose clock it is on, and the code somebody else can walk in
    // with. A room that opens and then cannot describe itself is the failure
    // a plain 200 from /api/jams would sail past.
    await expect(panel.getByText('Just you so far')).toBeVisible();
    await expect(panel.getByText(new RegExp(`^${HOST}`)).first()).toBeVisible();
    await expect(panel.getByText('Host', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: `Copy the code ${code}` })).toBeVisible();

    // And the room knows what is on: the one line a member whose library
    // lacks the song still gets.
    await expect(panel.getByRole('group', { name: /^Playing: / })).toBeVisible();
  });

  test('a friend on the same network is offered the room, and only once', async ({ page, browser, world }) => {
    await startRoom(page);

    const kim = await guest(browser, world);
    try {
      // The offer names the host, the song, and why it is being made.
      const drawer = kim.page.getByText(`${HOST} started a groove nearby`);
      await expect(drawer).toBeVisible({ timeout: settle() });
      await expect(kim.page.getByText('on your network')).toBeVisible();

      await kim.page.getByRole('button', { name: 'Not now' }).click();
      await expect(drawer).toBeHidden();

      // Turned down once is turned down: the room is still live and still
      // nearby, so an offer that came back on the next launch would be the
      // app nagging. Given three poll rounds to misbehave in.
      await kim.page.reload();
      await expect(kim.page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
      await kim.page.waitForTimeout(BEAT.POLL_ROOM);
      await expect(kim.page.getByText(`${HOST} started a groove nearby`)).toBeHidden();
    } finally {
      await kim.context.close();
    }
  });

  test('joining asks where to hear it, lands in the room, and opens the deck exactly once', async ({
    page,
    browser,
    world,
  }) => {
    await startRoom(page);
    const kim = await guest(browser, world);
    try {
      await expect(kim.page.getByText(`${HOST} started a groove nearby`)).toBeVisible({ timeout: settle() });

      // The question is asked BEFORE anything plays - a guest whose phone is
      // in a room with the host's speaker must not be made to find that out
      // by hearing themselves twice.
      await kim.page.getByRole('button', { name: new RegExp(`^Join ${HOST}.s groove$`) }).click();
      await expect(kim.page.getByText('Where should the music play?')).toBeVisible({ timeout: settle() });
      await kim.page.getByRole('button', { name: /^On this device/ }).click();

      // In, and the deck came up to say so.
      await expect(deck(kim.page, FOLLOWING).first()).toBeVisible({ timeout: settle() });
      await expect(kim.page.getByText(`${HOST}'s groove`)).toBeVisible();

      // ONCE. The arm that lifts this panel is taken by whichever deck is
      // standing - there are two seats, the strip's and the sheet's - and a
      // join that opened both would put two identical panels on the screen.
      await expect(deck(kim.page, FOLLOWING)).toHaveCount(1);

      // And the host sees the room fill.
      const hostDeck = await openDeck(page, HOSTING);
      await expect(hostDeck.getByText('You and kim')).toBeVisible({ timeout: settle() });
    } finally {
      await kim.context.close();
    }
  });

  test("the follower's transport follows the host", async ({ page, browser, world }) => {
    await startRoom(page);
    const kim = await guest(browser, world);
    try {
      await joinNearby(kim.page, HOST, 'device');
      const room = deck(kim.page, FOLLOWING).first();
      await expect(room).toBeVisible({ timeout: settle() });
      await expect(room.getByRole('group', { name: /^Playing: / })).toBeVisible({ timeout: settle() });
      const first = (await room.getByRole('group', { name: /^Playing: / }).getAttribute('aria-label')) ?? '';

      // 1. The host pauses. The room says so, and the guest's own element
      //    stops - a follower that keeps playing over a paused room is the
      //    whole feature failing quietly.
      await nowPlaying(page).getByRole('button', { name: 'Pause' }).click();
      await expect(room.getByRole('group', { name: /^Paused: / })).toBeVisible({ timeout: settle() });
      await expect
        .poll(async () => (await audioState(kim.page)).every((el) => el.paused), { timeout: settle() })
        .toBe(true);

      // 2. And starts again.
      await nowPlaying(page).getByRole('button', { name: 'Play', exact: true }).click();
      await expect(room.getByRole('group', { name: /^Playing: / })).toBeVisible({ timeout: settle() });
      await expect
        .poll(async () => (await audioState(kim.page)).some((el) => !el.paused), { timeout: settle() })
        .toBe(true);

      // 3. The host skips. The room is on a different song and the guest is
      //    told which - by NAME, which is what a member whose library never
      //    listed it has to go on.
      await nowPlaying(page).getByRole('button', { name: 'Next', exact: true }).click();
      await expect
        .poll(
          async () => room.getByRole('group', { name: /^Playing: / }).getAttribute('aria-label'),
          { timeout: settle(4) },
        )
        .not.toBe(first);
    } finally {
      await kim.context.close();
    }
  });

  test("a guest's add is answered, and joins the host's line credited to them", async ({
    page,
    browser,
    world,
    hub,
  }) => {
    /*
     * The host opens the room on a ONE-SONG line, and that is the whole setup.
     *
     * `fold` says in as many words that "anything already queued is left where
     * it is", so a guest sending a song the host's line already holds is a
     * deliberate no-op - and the host's usual line here is the entire fixture
     * library, which means every possible send is already in it and nothing
     * an add does is visible. Liking one song and playing the Liked shelf
     * gives the room a line of one, which is the only shape where "it joined
     * the line" is a thing the screen can show. Set through the hub's own API
     * because it is setup, not the thing under test.
     */
    const seed = (await hub.tracks()).find((t) => t.title === 'Ledger Line');
    expect(seed).toBeTruthy();
    const seedId = seed!.id as number;
    await hub.put(`/api/favorites/${seedId}`, { favorite: true });

    const kim = await guest(browser, world);
    try {
      await openLibrary(page, HOST_DEVICE);
      const liked = cards(page).nth(12);
      await expect(liked).toBeVisible({ timeout: settle() });
      await liked.click();
      await expect(nowPlaying(page)).toBeVisible();
      await nowPlaying(page).getByRole('button', { name: 'Start a groove' }).click();
      await page.getByRole('button', { name: /^Start a groove:/ }).click();
      await expect(page.locator('.jamInvite__mono').first()).toBeVisible({ timeout: settle() });
      await page.keyboard.press('Escape');

      await kim.page.reload();
      await expect(kim.page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
      await joinNearby(kim.page, HOST, 'device');
      await expect(deck(kim.page, FOLLOWING).first()).toBeVisible({ timeout: settle() });
      // The deck lands OVER the library it was opened from; put it down before
      // reaching past it for a song.
      await kim.page.keyboard.press('Escape');

      // Following a room, both queue verbs are named for where they land -
      // "the groove", not "the queue" - so a member never has to wonder whose
      // line they are joining.
      await expect(cards(kim.page).nth(11)).toBeVisible();
      const song = await fromTrackMenu(kim.page, cards(kim.page).nth(6), 'Add to the groove');
      expect(song).not.toBe('Ledger Line');

      // The app ANSWERS. "You did something and the app said nothing" was the
      // complaint these two verbs were built to end, and a send that goes to
      // somebody else's player is where silence is worst: there is no queue on
      // this screen to watch it appear in.
      await expect(kim.page.getByText(/sent to the groove/)).toBeVisible({ timeout: settle() });

      // Then the host's beat folds it in, and the room's line carries the song
      // WITH the name of who asked for it - on both decks. That credit is the
      // assertion: it is the only thing separating a member's add from a song
      // that was in the host's own list all along.
      const credited = new RegExp(`${song}.*added by kim`);
      const hostLine = (await openDeck(page, HOSTING)).getByRole('list', { name: "The room's queue" });
      await expect(hostLine.getByRole('listitem', { name: credited })).toBeVisible({ timeout: settle(4) });

      const guestLine = (await openDeck(kim.page, FOLLOWING)).getByRole('list', {
        name: "The room's queue",
      });
      await expect(guestLine.getByRole('listitem', { name: credited })).toBeVisible({ timeout: settle(4) });
    } finally {
      await kim.context.close();
      await hub.put(`/api/favorites/${seedId}`, { favorite: false });
    }
  });

  test("a guest's PLAY NEXT is what plays next, and does not queue the song twice", async ({
    page,
    browser,
    world,
  }) => {
    await startRoom(page);
    const kim = await guest(browser, world);
    try {
      await joinNearby(kim.page, HOST, 'device');
      await expect(deck(kim.page, FOLLOWING).first()).toBeVisible({ timeout: settle() });
      await kim.page.keyboard.press('Escape');
      await expect(cards(kim.page).nth(11)).toBeVisible();

      // The host is playing the whole library, so this song is ALREADY
      // somewhere down the room's line. Asking for it next therefore has one
      // correct answer - move it - and one tempting wrong one, which is to
      // append a second copy and leave the first where it was.
      const song = await fromTrackMenu(kim.page, cards(kim.page).nth(6), 'Play next in the groove');

      const hostDeck = await openDeck(page, HOSTING);
      const rows = hostDeck.getByRole('list', { name: "The room's queue" }).getByRole('listitem');

      // Folded in, credited, and in the line exactly once.
      await expect(rows.filter({ hasText: song })).toHaveCount(1, { timeout: settle(4) });
      await expect(rows.filter({ hasText: song })).toHaveAccessibleName(/added by kim/);

      // And now the promise itself, which no position in a list can stand in
      // for: the next song out of the host's speakers is the guest's.
      await page.keyboard.press('Escape');
      await nowPlaying(page).getByRole('button', { name: 'Next', exact: true }).click();
      await expect.poll(async () => sheetTitle(page), { timeout: settle() }).toBe(song);
    } finally {
      await kim.context.close();
    }
  });

  test("hearing it on the host's speaker keeps the guest's own player quiet, and its controls still steer the room", async ({
    page,
    browser,
    world,
  }) => {
    await startRoom(page);
    const kim = await guest(browser, world);
    try {
      await joinNearby(kim.page, HOST, 'speaker');
      await expect(deck(kim.page, FOLLOWING).first()).toBeVisible({ timeout: settle() });
      await kim.page.keyboard.press('Escape');

      // Nothing is coming out of this phone. That is the whole promise of the
      // choice, and an <audio> that quietly kept a source would be two copies
      // of the same song in one room.
      await expect
        .poll(async () => (await audioState(kim.page)).every((el) => el.src === '' || el.paused), {
          timeout: settle(),
        })
        .toBe(true);

      // But the strip is still a transport, with a scrubber that MOVES -
      // carried forward off the host's clock rather than off any local
      // element. A follower on the speaker with a frozen scrubber reads as a
      // room that has stopped.
      const seek = kim.page.getByRole('slider', { name: 'Seek' }).first();
      await expect(seek).toBeVisible();
      const at = await seekAt(seek);
      await expect.poll(async () => seekAt(seek), { timeout: BEAT.HOST * 3 }).toBeGreaterThan(at);

      // And the guest's hand on the transport reaches the host: the press is
      // queued on the hub and drained by the host's next beat.
      await kim.page.getByRole('button', { name: 'Pause' }).first().click();
      await expect
        .poll(async () => (await audioState(page)).every((el) => el.paused), { timeout: settle(4) })
        .toBe(true);
    } finally {
      await kim.context.close();
    }
  });

  test('a code walks you in while the room stands, and is refused in plain words once it does not', async ({
    page,
    browser,
    world,
  }) => {
    const code = await startRoom(page);
    const kim = await guest(browser, world);
    try {
      // The nearby offer is in the way of the door this test is about, and
      // turning it down is what somebody who was given a code by hand does.
      await kim.page.getByRole('button', { name: 'Not now' }).click({ timeout: settle() });

      // A guest with no deck of their own has no groove glyph to press, so
      // the way to the code sheet starts with something playing - which is
      // also how a person holding a code arrives at it.
      await kim.page.getByRole('button', { name: 'Play', exact: true }).click();
      await expect(nowPlaying(kim.page)).toBeVisible();
      await nowPlaying(kim.page).getByRole('button', { name: 'Start a groove' }).click();
      await kim.page.getByRole('button', { name: /^Have a code/ }).click();

      // By ROLE: the card that opens this sheet is labelled "Have a code? Join
      // a groove by its code or link", so a bare `getByLabel` finds the door
      // as well as the field.
      const field = kim.page.getByRole('textbox', { name: 'Code or link' });
      await expect(field).toBeVisible();

      // Something that is not a code at all is said so before anything is
      // sent anywhere - the sheet reads what is being typed.
      await field.fill('not a code at all');
      await expect(kim.page.getByText(/A code is a few letters and numbers/)).toBeVisible();

      // The live code walks straight in, question and all.
      await field.fill(code);
      await kim.page.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(kim.page.getByText('Where should the music play?')).toBeVisible({ timeout: settle() });
      await kim.page.getByRole('button', { name: /^On this device/ }).click();
      await expect(deck(kim.page, FOLLOWING).first()).toBeVisible({ timeout: settle() });
      await kim.page.keyboard.press('Escape');

      // Now close the room under her and try the same code again. It has to
      // come back as a sentence that names both possibilities - the room may
      // be over, or a letter may be off - rather than as a shrug or a crash.
      // (A code alone genuinely cannot tell those apart; only a SHARE LINK
      // carries the registry row that outlives the room and lets the app say
      // "ended" outright, which is why grooveEntry keeps 'ended' and 'missing'
      // as separate answers and why `bare` is on the missing one.)
      const hostDeck = await openDeck(page, HOSTING);
      await hostDeck.getByRole('button', { name: 'End the groove for everyone' }).click();
      await expect(deckGlyph(page, HOSTING)).toHaveCount(0, { timeout: settle() });
      await expect(deckGlyph(kim.page, FOLLOWING)).toHaveCount(0, { timeout: settle(4) });

      await nowPlaying(kim.page).getByRole('button', { name: 'Start a groove' }).click();
      await kim.page.getByRole('button', { name: /^Have a code/ }).click();
      const again = kim.page.getByRole('textbox', { name: 'Code or link' });
      await again.fill(code);
      await kim.page.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(kim.page.getByText(/No groove answers to that code/)).toBeVisible({ timeout: settle() });
      await expect(kim.page.getByText(/It may have ended, or a letter is off/)).toBeVisible();
    } finally {
      await kim.context.close();
    }
  });

  test('the host ending the room for everyone takes the guest out of it too', async ({
    page,
    browser,
    world,
  }) => {
    await startRoom(page);
    const kim = await guest(browser, world);
    try {
      await joinNearby(kim.page, HOST, 'device');
      await expect(deck(kim.page, FOLLOWING).first()).toBeVisible({ timeout: settle() });
      await kim.page.keyboard.press('Escape');

      // With somebody else in it, a host has two ways out and they mean
      // different things - stepping out hands the room on, and only this one
      // closes it. Leaving used to do both, which is the one thing a host
      // stepping out for a moment never meant.
      const hostDeck = await openDeck(page, HOSTING);
      await expect(hostDeck.getByRole('button', { name: 'Leave, and hand the groove on' })).toBeVisible();
      await hostDeck.getByRole('button', { name: 'End the groove for everyone' }).click();

      // The guest is told, and is out - not left following a room that is not
      // there, which is the state a dropped connection produces and which
      // must not be reachable from a clean close.
      await expect(kim.page.getByText(`${HOST}'s groove ended`)).toBeVisible({ timeout: settle(4) });
      await expect(deckGlyph(kim.page, FOLLOWING)).toHaveCount(0, { timeout: settle(4) });
      await expect(deckGlyph(page, HOSTING)).toHaveCount(0);
    } finally {
      await kim.context.close();
    }
  });

  test('@slow a host that goes quiet hands the clock to whoever is left', async ({ page, browser, world }) => {
    await startRoom(page);
    const kim = await guest(browser, world);
    try {
      await joinNearby(kim.page, HOST, 'device');
      await expect(deck(kim.page, FOLLOWING).first()).toBeVisible({ timeout: settle() });
      await kim.page.keyboard.press('Escape');

      // The host's app goes away without ending anything - a closed laptop, a
      // tab shut, a phone that died. The room is NOT over: somebody is still
      // in it, and after the quiet window the clock passes to them rather
      // than the music simply stopping.
      await page.close();

      await expect(deckGlyph(kim.page, HOSTING).first()).toBeVisible({
        timeout: BEAT.HANDOFF + settle(4),
      });
      // Hers now, and the deck says so in the same words it said them to ana.
      const kimsRoom = await openDeck(kim.page, HOSTING);
      await expect(kimsRoom.getByText(/^kim/).first()).toBeVisible();
      await expect(kimsRoom.getByText('Host', { exact: true })).toBeVisible();
    } finally {
      await kim.context.close();
    }
  });
});
