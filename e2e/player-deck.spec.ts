/**
 * The deck: the one part of this app that is not allowed to be almost right.
 *
 * Everything here runs against the real hub, the real (silent) files and the
 * real byte-range server, because every interesting failure the deck has had
 * lived in the seam between the button and the bytes: a Pause that flipped a
 * glyph and kept playing, a Next that did nothing, a seek that landed on zero
 * because the file was served without a 206, a reorder the player never read.
 * None of those are visible to a component test.
 *
 * Two oracles are used throughout, and they are deliberately different in kind:
 *
 *   - `aria-valuenow` on the Seek control, which is the number a screen reader
 *     is told and therefore the number the listener is told;
 *   - `navigator.mediaSession`, which is what the lock screen, Control Center
 *     and CarPlay render.
 *
 * A scenario that only read the DOM would pass with the audio element stopped;
 * one that only read the element would pass with the whole screen naming the
 * wrong song. Where both are asserted, they are asserted to AGREE.
 *
 * The shape under test is the desktop one, where Now Playing is DOCKED beside
 * the page rather than lifted over it - so `getByRole('dialog', { name: 'Now
 * playing' })` is the transport, and the floating strip stands down. That is
 * the shape `devices['Desktop Chrome']` gives every project in this repo.
 */
import { expect, test } from './fixtures/hub.ts';
import {
  DEVICE,
  audioState,
  cards,
  fromTrackMenu,
  nowPlaying,
  openLibrary,
  seekAt,
  seekMax,
  seekNearTheEnd,
  sheetTitle,
  systemNowPlaying,
} from './fixtures/deck.ts';

/*
 * Signed in as kim, not the default matt, and always on one device.
 *
 * Nothing here is about kim; it is about not leaving matt's Connect seat warm
 * for the spec that runs next. See DEVICE in fixtures/deck.ts, which carries
 * the whole reasoning - it cost nine of these twelve tests on the first run
 * and then the harness's own smoke on a later one.
 */
test.use({ afmUser: 'kim' });

/** The library page's own Play, which starts the whole shelf in the order it
 *  hands the player - and which the transport's own Play button then shares a
 *  name with, hence `exact` at every call site. */
const playAll = 'Play';

test.describe('the transport', () => {
  test('plays, pauses, and the clock is the proof', async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));

    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();

    const seek = nowPlaying(page).getByRole('slider', { name: 'Seek' });
    await expect(seek).toBeVisible();

    // 1. It is really playing: the number moves, and the system is told so.
    const started = await seekAt(seek);
    await expect.poll(async () => seekAt(seek), { timeout: 15_000 }).toBeGreaterThan(started + 1);
    await expect.poll(async () => (await systemNowPlaying(page)).state, { timeout: 10_000 }).toBe('playing');

    // 2. Pause HOLDS. A glyph that flips while the element keeps running is
    //    the exact failure this guards, so the position is read, left alone
    //    for a few seconds, and read again: it has to be the same number.
    await nowPlaying(page).getByRole('button', { name: 'Pause' }).click();
    await expect(nowPlaying(page).getByRole('button', { name: playAll, exact: true })).toBeVisible();
    await expect
      .poll(async () => (await audioState(page)).every((el) => el.paused), { timeout: 5_000 })
      .toBe(true);
    const held = await seekAt(seek);
    await expect.poll(async () => seekAt(seek), { timeout: 3_000, intervals: [500, 500, 500] }).toBe(held);
    expect((await systemNowPlaying(page)).state).toBe('paused');

    // 3. And Play picks it up where it stopped, not from the top.
    await nowPlaying(page).getByRole('button', { name: playAll, exact: true }).click();
    await expect.poll(async () => seekAt(seek), { timeout: 15_000 }).toBeGreaterThan(held);

    expect(crashes).toEqual([]);
  });

  test('tells the system what it is playing, and the screen agrees', async ({ page, world }) => {
    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();

    // The generic "AttackFM" card - a webview's starved default when nobody
    // has claimed the session - is what this guards against, so it is not
    // enough that SOMETHING is published: it has to be a song from this
    // library, and it has to be the song the screen is naming.
    await expect.poll(async () => (await systemNowPlaying(page)).title, { timeout: 10_000 }).not.toBe('');
    const system = await systemNowPlaying(page);

    expect(world.library.tracks.map((t) => t.title)).toContain(system.title);
    expect(world.library.albums.map((a) => a.artist)).toContain(system.artist);
    expect(await sheetTitle(page)).toBe(system.title);
  });

  test('next and previous walk the list the library handed it', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();
    await expect.poll(async () => (await systemNowPlaying(page)).title, { timeout: 10_000 }).not.toBe('');

    const first = await sheetTitle(page);

    // "A next-send that did nothing" is in this repo's own history, and on
    // screen it reads as a button with no effect at all - so the assertion is
    // that the SONG changed, not that a request went out.
    await nowPlaying(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(async () => sheetTitle(page), { timeout: 10_000 }).not.toBe(first);
    const second = await sheetTitle(page);
    await expect.poll(async () => (await systemNowPlaying(page)).title, { timeout: 10_000 }).toBe(second);

    // Previous in the first seconds of a song means "the one before", not
    // "start this one again" - the only reading that gets you back.
    await nowPlaying(page).getByRole('button', { name: 'Previous', exact: true }).click();
    await expect.poll(async () => sheetTitle(page), { timeout: 10_000 }).toBe(first);
  });

  test('a seek moves the audio, not just the slider', async ({ page, world }) => {
    // Every /api/stream reply. A file served as a plain 200 still plays, and a
    // scrubber dragged across it still moves - it is the 206 that says the
    // element could actually go there, and its absence is what makes every
    // seek land on zero.
    const streamed: Array<{ status: number; ranged: boolean }> = [];
    page.on('response', (reply) => {
      if (reply.url().startsWith(`${world.hubUrl}/api/stream/`)) {
        streamed.push({ status: reply.status(), ranged: !!reply.request().headers()['range'] });
      }
    });

    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();
    const seek = nowPlaying(page).getByRole('slider', { name: 'Seek' });
    await expect.poll(async () => seekAt(seek), { timeout: 15_000 }).toBeGreaterThan(0);

    const total = await seekMax(seek);
    // Off the file, not off a tag: 12-22 s is the fixture, and an element that
    // never loaded reports NaN or Infinity.
    expect(total).toBeGreaterThan(5);
    expect(total).toBeLessThan(60);

    // Past the middle of the file, one keyboard step at a time - the same code
    // path the drag takes, and the only one a test can aim precisely.
    const before = await seekAt(seek);
    await seek.focus();
    await expect(async () => {
      await seek.press('ArrowRight');
      expect(await seekAt(seek)).toBeGreaterThan(total / 2);
    }).toPass({ timeout: 20_000 });
    const after = await seekAt(seek);

    // A jump, not the couple of seconds of ordinary playing that went past
    // while the presses were happening.
    expect(after - before).toBeGreaterThan(3);

    // And the ELEMENT went there, which is the half a slider cannot fake.
    await expect
      .poll(async () => Math.max(0, ...(await audioState(page)).map((el) => el.at)), { timeout: 10_000 })
      .toBeGreaterThan(after - 2);

    expect(streamed.length).toBeGreaterThan(0);
    expect(streamed.every((s) => s.status === 200 || s.status === 206)).toBe(true);
    expect(streamed.some((s) => s.ranged && s.status === 206)).toBe(true);
  });
});

test.describe('the queue', () => {
  test('add to queue joins the end of the line; play next goes straight behind the song on', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();

    // Two different records, so neither can be mistaken for what is playing -
    // the shelf's Play button starts on the newest one.
    const appended = await fromTrackMenu(page, cards(page).nth(6), 'Add to queue');
    const jumped = await fromTrackMenu(page, cards(page).nth(3), 'Play next');
    expect(jumped).not.toBe(appended);

    await nowPlaying(page).getByRole('button', { name: 'Queue' }).click();
    const queue = page.getByRole('dialog', { name: 'Queue' });
    await expect(queue).toBeVisible();

    // The hand-queued lane, in order. "Play next" was asked SECOND and has to
    // be FIRST: it means "right after the song on", and a queue that simply
    // appends both is the failure that reads as the verb doing nothing.
    const lane = queue.locator('li').filter({ has: page.getByRole('button', { name: /^Reorder / }) });
    await expect(lane).toHaveCount(2);
    await expect(lane.nth(0)).toContainText(jumped);
    await expect(lane.nth(1)).toContainText(appended);
  });

  test('a reordered queue is the order that plays', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();

    const first = await fromTrackMenu(page, cards(page).nth(3), 'Add to queue');
    const second = await fromTrackMenu(page, cards(page).nth(6), 'Add to queue');
    expect(first).not.toBe(second);

    await nowPlaying(page).getByRole('button', { name: 'Queue' }).click();
    const queue = page.getByRole('dialog', { name: 'Queue' });
    const lane = queue.locator('li').filter({ has: page.getByRole('button', { name: /^Reorder / }) });
    await expect(lane).toHaveCount(2);
    await expect(lane.nth(0)).toContainText(first);

    // The kit's keyboard reorder: lift with Space, move with an arrow, drop
    // with Space. Worth using rather than a drag - it resolves through the
    // same move either way, and it is the half of the control with no pointer
    // heuristics to go wrong.
    const handle = queue.getByRole('button', { name: `Reorder ${second}` });
    await handle.focus();
    await handle.press(' ');
    await handle.press('ArrowUp');
    await handle.press(' ');
    await expect(lane.nth(0)).toContainText(second);

    // And now the part nothing else in the app checks: the DECK reads the new
    // order. A panel that reorders its own rows and hands the player the old
    // list is invisible until somebody presses skip - which is what this does.
    await queue.getByRole('button', { name: 'Close queue' }).click();
    await nowPlaying(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(async () => sheetTitle(page), { timeout: 10_000 }).toBe(second);
  });

  test('removing a song takes it out of the line and leaves the rest standing', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();

    const kept = await fromTrackMenu(page, cards(page).nth(3), 'Add to queue');
    const dropped = await fromTrackMenu(page, cards(page).nth(6), 'Add to queue');
    expect(kept).not.toBe(dropped);

    await nowPlaying(page).getByRole('button', { name: 'Queue' }).click();
    const queue = page.getByRole('dialog', { name: 'Queue' });
    const lane = queue.locator('li').filter({ has: page.getByRole('button', { name: /^Reorder / }) });
    await expect(lane).toHaveCount(2);

    await queue.getByRole('button', { name: `Remove ${dropped} from the queue` }).click();
    await expect(lane).toHaveCount(1);
    await expect(lane.nth(0)).toContainText(kept);

    // Taking one out must not take the other with it, and must not leave the
    // deck pointing at a row that has gone.
    await queue.getByRole('button', { name: 'Close queue' }).click();
    await nowPlaying(page).getByRole('button', { name: 'Next', exact: true }).click();
    await expect.poll(async () => sheetTitle(page), { timeout: 10_000 }).toBe(kept);
  });
});

test.describe('shuffle, repeat, and the end of a list', () => {
  test('shuffle deals a run with no song in it twice', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();
    await expect.poll(async () => (await systemNowPlaying(page)).title, { timeout: 10_000 }).not.toBe('');

    const shuffle = nowPlaying(page).getByRole('button', { name: 'Shuffle' });
    await expect(shuffle).toHaveAttribute('aria-pressed', 'false');
    await shuffle.click();
    await expect(shuffle).toHaveAttribute('aria-pressed', 'true');

    // Five songs out of twelve, none of them repeated. A shuffle that picks
    // uniformly at random each step - the obvious wrong implementation - hands
    // you the same song twice inside five about half the time; a shuffle that
    // walks a shuffled ORDER never can.
    const heard = [await sheetTitle(page)];
    for (let i = 0; i < 4; i += 1) {
      const previous = heard[heard.length - 1]!;
      await nowPlaying(page).getByRole('button', { name: 'Next', exact: true }).click();
      await expect.poll(async () => sheetTitle(page), { timeout: 10_000 }).not.toBe(previous);
      heard.push(await sheetTitle(page));
    }
    expect(new Set(heard).size).toBe(heard.length);
  });

  test('shuffle and repeat are still set after a relaunch', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();

    await nowPlaying(page).getByRole('button', { name: 'Shuffle' }).click();
    // off -> all -> one. Stopping at "all" so the assertion is not the same
    // word as the default.
    await nowPlaying(page).getByRole('button', { name: 'Repeat: off' }).click();
    await expect(nowPlaying(page).getByRole('button', { name: 'Repeat: all' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

    // The deck itself does not come back - a reload is a fresh app with no
    // song on, and the cross-device resume that WOULD offer one lives in the
    // registry, not here. The dials are a different thing: Player.tsx says in
    // as many words that shuffle and repeat "survive a relaunch the way every
    // other playback preference does", so a fresh deck must open wearing them.
    await expect(page.getByRole('button', { name: playAll, exact: true })).toBeVisible();
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();

    await expect(nowPlaying(page).getByRole('button', { name: 'Repeat: all' })).toBeVisible();
    await expect(nowPlaying(page).getByRole('button', { name: 'Shuffle' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('repeat one plays the same song again when the file runs out', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);
    await page.getByRole('button', { name: playAll, exact: true }).click();
    await expect(nowPlaying(page)).toBeVisible();
    await expect.poll(async () => (await systemNowPlaying(page)).title, { timeout: 10_000 }).not.toBe('');
    const song = await sheetTitle(page);

    // off -> all -> one.
    await nowPlaying(page).getByRole('button', { name: 'Repeat: off' }).click();
    await nowPlaying(page).getByRole('button', { name: 'Repeat: all' }).click();
    await expect(nowPlaying(page).getByRole('button', { name: 'Repeat: one' })).toBeVisible();

    const seek = nowPlaying(page).getByRole('slider', { name: 'Seek' });
    await seekNearTheEnd(seek);

    // It wraps: the position drops back to the top of the SAME file rather
    // than the list moving on, which is what "one" has to mean and the first
    // thing a shared ended-handler gets wrong.
    await expect.poll(async () => seekAt(seek), { timeout: 25_000 }).toBeLessThan(5);
    expect(await sheetTitle(page)).toBe(song);
    await expect.poll(async () => (await systemNowPlaying(page)).title, { timeout: 5_000 }).toBe(song);
  });

  test('repeat all wraps from the last song of the list back to the first', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);

    // The oldest card in Recently added is the LAST song of the list the shelf
    // hands the player, so there is nowhere further to go but round.
    await cards(page).nth(11).scrollIntoViewIfNeeded();
    await cards(page).nth(11).click();
    await expect(nowPlaying(page)).toBeVisible();
    await expect.poll(async () => (await systemNowPlaying(page)).title, { timeout: 10_000 }).not.toBe('');
    const last = await sheetTitle(page);

    await nowPlaying(page).getByRole('button', { name: 'Repeat: off' }).click();
    await expect(nowPlaying(page).getByRole('button', { name: 'Repeat: all' })).toBeVisible();

    await seekNearTheEnd(nowPlaying(page).getByRole('slider', { name: 'Seek' }));

    await expect.poll(async () => sheetTitle(page), { timeout: 30_000 }).not.toBe(last);
    await expect.poll(async () => (await systemNowPlaying(page)).state, { timeout: 10_000 }).toBe('playing');
  });

  test('with repeat off the last song of a list plays out and the deck stops there', async ({ page }) => {
    await openLibrary(page, DEVICE.kim);
    await cards(page).nth(11).scrollIntoViewIfNeeded();
    await cards(page).nth(11).click();
    await expect(nowPlaying(page)).toBeVisible();
    await expect.poll(async () => (await systemNowPlaying(page)).title, { timeout: 10_000 }).not.toBe('');
    const last = await sheetTitle(page);
    await expect(nowPlaying(page).getByRole('button', { name: 'Repeat: off' })).toBeVisible();

    await seekNearTheEnd(nowPlaying(page).getByRole('slider', { name: 'Seek' }));

    // The run is over, so the sound stops. What it must not do is wrap to the
    // top of the list with repeat off, and it must not throw the song away -
    // the screen still names what you were listening to.
    await expect.poll(async () => (await systemNowPlaying(page)).state, { timeout: 25_000 }).not.toBe('playing');
    await expect
      .poll(async () => (await audioState(page)).every((el) => el.paused), { timeout: 10_000 })
      .toBe(true);
    expect(await sheetTitle(page)).toBe(last);
  });
});
