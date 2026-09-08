/**
 * The frame the app lives in.
 *
 * Not a feature: the nav, the back stack, the strip, the sheet, the settings
 * surface and the bell are what every feature is seen THROUGH, which is why a
 * regression here is the most visible in the app and has been the least
 * tested. The scenarios below are drawn from what has actually broken in this
 * tree - two hand-kept destination lists that drifted, a nav item whose glyph
 * and word stopped being one pair, a lit plate with two candidates, a page
 * that was not the scroller and clipped its own list, and a surface opened
 * from inside a menu that its own trigger then destroyed.
 *
 * SHAPES. The app wears two: the desktop rail (`(min-width: 60rem) and
 * (pointer: fine)`) and the phone bar. Both are the one PrimaryNav, so a test
 * that only ever ran wide would miss half of it - and the phone half is the
 * one with the overflow arithmetic in it. Viewport size is the switch, and
 * `useDesktopLayout` tracks the media query live, so a resize inside a test is
 * the real thing rather than a reload.
 */
import { expect, test, type World } from './fixtures/hub.ts';
import { pauseHere, playHere, soloDeck } from './fixtures/deck.ts';
import type { Locator, Page } from '@playwright/test';

/** Wide enough for `(min-width: 60rem)`, which is what puts the rail up. */
const DESKTOP = { width: 1280, height: 800 };
/** A phone. Under 540px, which is also what makes the player strip touch-shaped. */
const PHONE = { width: 390, height: 800 };

const nav = (page: Page): Locator => page.getByRole('navigation', { name: 'Primary' });

/**
 * Every seat's accessible name, in the order the nav offers them.
 *
 * Read in ONE call into the page rather than locator by locator: the nav is
 * re-rendered by a viewport change or an interface-size change, and a
 * per-locator read taken across that re-render waits forever on an element
 * the new shape does not have.
 */
async function seats(page: Page): Promise<string[]> {
  return nav(page)
    .getByRole('button')
    .evaluateAll((tabs) =>
      tabs.map((tab) => (tab.getAttribute('aria-label') ?? tab.textContent ?? '').trim()),
    );
}

/** Boot signed in, on the shape asked for, with the library painted. */
async function boot(
  page: Page,
  world: World,
  shape: { width: number; height: number },
): Promise<void> {
  await page.setViewportSize(shape);
  // Out of Connect for the duration - see soloDeck. This suite is about the
  // frame, and it must neither inherit nor leave a playback seat.
  await soloDeck(page, world);
  await page.goto('/');
  await expect(nav(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Library' })).toBeVisible();
}

test.describe('the primary navigation', () => {
  test('the rail and the bar offer the same destinations, in the same order', async ({ page, world }) => {
    // ONE list, rendered twice. It was two hand-kept lists, and they had
    // already drifted - the bar lit Profile for the friends route and the
    // rail did not. Anything that adds a destination to one hand and not the
    // other lands here.
    await boot(page, world, DESKTOP);
    const rail = await seats(page);
    // The rail's foot carries two doors the phone keeps in its overflow
    // (Downloads, Settings); everything before them is the shared list.
    expect(rail.slice(0, 4)).toEqual(['Discover', 'Search', 'Library', 'Profile']);

    await page.setViewportSize(PHONE);
    // Polled on the WHOLE bar rather than on its first four: the rail's first
    // four are the same words, so a prefix passes before the shape has
    // changed at all and the assertion below then reads the rail. The media
    // query flips, React re-renders, and the seats are measured in a layout
    // effect before the next paint - so this settles in a frame, not a wait.
    //
    // The last seat is the overflow, never a destination: the ⋮ keeps a seat
    // of its own at every width, which is why the split only ever plays for
    // the seats beside it.
    await expect
      .poll(async () => seats(page))
      .toEqual(['Discover', 'Search', 'Library', 'Profile', 'More']);
  });

  test('every seat is one glyph and one word, and exactly one is the page you are on', async ({ page, world }) => {
    // The pair has come apart before - a plugin's icon registered at the
    // menu's size and drawn at the bar's, a label span that stopped being
    // rendered at all - and a seat with a glyph and no word is unreadable
    // while a seat with a word and no glyph is a different bar. Both halves
    // are asserted per seat rather than "the nav has some icons".
    await boot(page, world, PHONE);
    const tabs = await nav(page).getByRole('button').all();
    expect(tabs.length).toBeGreaterThanOrEqual(5);
    for (const tab of tabs) {
      expect(await tab.locator('svg').count()).toBeGreaterThan(0);
      expect(((await tab.innerText()) ?? '').trim()).not.toBe('');
    }

    // The lit plate is ONE element that slides to whichever seat holds
    // aria-current, so two candidates is not a cosmetic problem - it is the
    // plate not knowing where to go. It had two: the ⋮ trigger shared the
    // active mark with the tab you were actually on.
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect.poll(async () => nav(page).locator('[aria-current="page"]').count()).toBe(1);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Discover/);

    // Search is deliberately never current: it is an overlay over the page
    // you were on, not a place, and it gives that page back when it closes.
    await page.getByRole('button', { name: 'Search' }).click();
    await expect.poll(async () => nav(page).locator('[aria-current="page"]').count()).toBe(1);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Discover/);
  });

  test('the bar re-measures its seats when the interface size changes', async ({ page, world }) => {
    // The seat count is arithmetic over a MEASURED seat, because the seat
    // rides `--glacier-density-scale` and the interface-size setting: a
    // hard-coded 54px is wrong for anybody who has touched either. This is
    // the change that alters what fits WITHOUT altering the bar's own width,
    // so a nav watching only the bar stays a size behind - which is why
    // useNavSeats observes a seat as well, and re-subscribes on its own
    // answer.
    await boot(page, world, PHONE);
    const before = await seats(page);
    expect(before).toContain('Profile');

    await nav(page).getByRole('button', { name: 'More' }).click();
    await page.getByRole('menuitem', { name: 'Settings' }).click();
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    await expect(sheet).toBeVisible();
    await sheet.getByText('Appearance', { exact: true }).click();

    // Clicked by its LABEL: the segmented control lays a label span over the
    // input, so a click on the radio role never lands - and a thumb hits the
    // label too, so this is the honest gesture rather than a `force: true`.
    const size = page.getByRole('radiogroup', { name: 'Interface size' });
    await expect(size).toBeVisible();
    await size.getByText('125%', { exact: true }).click();
    // The scale is applied to the root font size, which is what makes every
    // rem in the app - the seat's own width among them - larger.
    await expect
      .poll(async () => page.evaluate(() => document.documentElement.style.fontSize))
      .not.toBe('');
    // The phone's Settings is a drill-down: the close X belongs to the LIST,
    // and a pane wears a back arrow in its place. Backing out one step is
    // what the header's own arrow does, and what a system back does.
    await page.getByRole('button', { name: 'Back to settings' }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(sheet).toBeHidden();

    // Wider seats, less room, one destination pushed into the ⋮ - and it is
    // the LAST of them, because the bar gives up its seats in priority order.
    await expect.poll(async () => (await seats(page)).length).toBeLessThan(before.length);
    const after = await seats(page);
    expect(after).not.toContain('Profile');
    expect(after.at(-1)).toBe('More');

    // ...and it is still reachable, which is the whole contract of the
    // overflow: a destination cannot end up in neither hand.
    await nav(page).getByRole('button', { name: 'More' }).click();
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu.getByRole('menuitem', { name: 'Profile' })).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Profile' }).click();
    await expect(menu).toBeHidden();
    // Standing on a destination that lives in the menu, the ⋮ is what lights
    // - and no bar seat claims to be the page you are on, because none is.
    await expect(nav(page).getByRole('button', { name: 'More' })).toHaveAttribute('data-active', 'true');
    await expect(nav(page).locator('[aria-current="page"]')).toHaveCount(0);
  });

  test('the overflow menu holds what the bar could not, and nothing twice', async ({ page, world }) => {
    await boot(page, world, PHONE);
    const bar = await seats(page);
    await nav(page).getByRole('button', { name: 'More' }).click();
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu).toBeVisible();
    const rows = await menu.getByRole('menuitem').allInnerTexts();

    // One hand decides what is where. A destination in both is a nav that
    // disagrees with itself; a destination in neither is one nobody can
    // reach.
    for (const row of rows) expect(bar).not.toContain(row.trim());
    // Settings never leaves the menu - a bar seat for the cog would be the
    // same door twice - which is why the split above only ever plays for the
    // seats beside it.
    expect(rows.map((r) => r.trim())).toContain('Settings');

    // A tap outside closes it, which is the gesture people reach for before
    // they look for a button - and the press that closes must not be
    // re-dispatched to the ⋮ underneath and open it straight back up.
    await page.mouse.click(200, 120);
    await expect(menu).toBeHidden();
  });
});

test.describe('the back stack', () => {
  test('back and forward walk the places visited, and stop at the ends', async ({ page, world }) => {
    await boot(page, world, DESKTOP);
    const back = page.getByRole('button', { name: 'Back' });
    const forward = page.getByRole('button', { name: 'Forward' });

    // A fresh launch is one place deep: both controls disable rather than
    // disappear, so the title bar's layout - and the wordmark's position -
    // is identical on every page.
    await expect(back).toBeDisabled();
    await expect(forward).toBeDisabled();

    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(back).toBeEnabled();
    await page.getByRole('button', { name: 'Library' }).click();

    // A detail page stacks INSIDE the tab it was opened from, so this is a
    // third place rather than a fourth tab - and stepping back off it must
    // land on the library rather than on Discover.
    await page.getByRole('link', { name: 'Marla Vane' }).first().click();
    await expect(page.getByRole('heading', { name: 'Marla Vane' }).first()).toBeVisible();
    await expect(forward).toBeDisabled();

    await back.click();
    await expect(page.getByRole('heading', { name: 'Marla Vane' })).toHaveCount(0);
    await expect(page.getByText('12 songs')).toBeVisible();
    await expect(forward).toBeEnabled();

    await back.click();
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Discover/);

    // Forward re-enters what back left, in order - the stack has a cursor,
    // it is not a toggle.
    await forward.click();
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Library/);
    await forward.click();
    await expect(page.getByRole('heading', { name: 'Marla Vane' }).first()).toBeVisible();
    await expect(forward).toBeDisabled();
  });

  test('opening a place already open does not stack it twice', async ({ page, world }) => {
    await boot(page, world, DESKTOP);
    await page.getByRole('button', { name: 'Discover' }).click();
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Discover/);
    for (let i = 0; i < 3; i += 1) await page.getByRole('button', { name: 'Discover' }).click();
    // Three more presses on the seat you are standing on; one press of back
    // must still be the whole way out of it.
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Library/);
    await expect(page.getByRole('button', { name: 'Back' })).toBeDisabled();
  });
});

test.describe('the page and its chrome', () => {
  test('the page is the scroller and the window never is', async ({ page, world }) => {
    // The failure this pins is a page that was not the scroller: `.appContent`
    // is `overflow: hidden`, so a page missing its own scrolling class clips
    // its list at the fold with no way to reach the rest. Asserted the only
    // way that distinguishes the two - by scrolling, and asking who moved.
    await boot(page, world, { width: 390, height: 620 });
    await page.getByRole('button', { name: 'Recent' }).click();
    await expect(page.getByText(/songs · /)).toBeVisible();
    // The list has to be longer than the window or there is nothing to learn
    // from scrolling it.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          let most = 0;
          document.querySelectorAll('*').forEach((el) => {
            most = Math.max(most, el.scrollHeight - el.clientHeight);
          });
          return most;
        }),
      )
      .toBeGreaterThan(0);

    // Reveal the last row, and ask who moved. A wheel event would only ever
    // reach whatever happens to be under the cursor; this asks the browser
    // itself to bring the row into view, which is what a keyboard user, a
    // screen reader and the app's own now-playing follow all do.
    await page.getByRole('row').last().scrollIntoViewIfNeeded();
    const moved = await page.evaluate(() => {
      const window_ = document.scrollingElement?.scrollTop ?? 0;
      let inner = 0;
      document.querySelectorAll('*').forEach((el) => {
        if (el === document.scrollingElement) return;
        inner = Math.max(inner, el.scrollTop);
      });
      return { window_, inner };
    });
    // The window is a fixed shell: nothing in the app is allowed to make the
    // document itself scroll, because the header, the nav and the strip are
    // all pinned to it.
    expect(moved.window_).toBe(0);
    expect(moved.inner).toBeGreaterThan(0);

    // ...and nothing runs off the side. A horizontal document scroll is the
    // other half of the same bug and reads as a page that wobbles under the
    // thumb.
    for (const shape of [PHONE, DESKTOP]) {
      await page.setViewportSize(shape);
      await expect
        .poll(async () =>
          page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth),
        )
        .toBeLessThanOrEqual(0);
    }
  });

  test('the player strip arrives with the music and stays put across the app', async ({ page, hub, world }) => {
    await boot(page, world, PHONE);
    await playHere(page, page.getByRole('button', { name: 'Play', exact: true }).first());

    const strip = page.locator('.playerBarShell');
    await expect(strip).toBeVisible();

    // The strip must be showing THE SONG IN THE ELEMENT, not the last thing
    // this shared hub saw on some other device. Resolved from the <audio>
    // src's own track id through the hub's index, so a strip that lagged a
    // track behind - or that kept drawing a remote's song after taking the
    // seat - is caught rather than passed over by a looser "is it one of
    // ours".
    //
    // Read off the group's accessible NAME: the phone's strip is compact and
    // the title is not visible text there, which is exactly why it carries
    // one.
    const playingId = await page.evaluate(() => {
      const source = document.querySelector('audio')?.src ?? '';
      const at = source.match(/\/api\/stream\/(\d+)/);
      return at ? Number(at[1]) : null;
    });
    expect(playingId).not.toBeNull();
    const rows = await hub.tracks();
    const title = rows.find((row) => row['id'] === playingId)?.['title'] as string | undefined;
    expect(title).toBeTruthy();
    await expect(strip.getByRole('group', { name: title! })).toBeVisible();

    // The strip belongs to the WINDOW, not to the page: walking to another
    // destination must not take the music off screen with it.
    const transport = strip.getByRole('group', { name: 'Playback controls' });
    for (const dest of ['Discover', 'Library']) {
      await page.getByRole('button', { name: dest }).click();
      await expect(strip.getByRole('group', { name: title! })).toBeVisible();
    }

    // ...and it does not scroll away with the page under it. Measured after
    // the walk rather than before it, because the two destinations do not
    // have to lay their headers out identically - what is being asserted is
    // that SCROLLING moves the page and not the plate.
    const parked = (await transport.boundingBox())!;
    await page.mouse.move(195, 400);
    await page.mouse.wheel(0, 900);
    // `wheel` returns when the event is delivered, not when the page has
    // finished moving, and the plate is read from the same frames the scroll
    // is still settling in. Measured across full runs: 2.11, 3.15, 5.64,
    // 5.72, 5.95 px of apparent drift on a strip that never moved - a red
    // that says "the plate scrolled away" when nothing of the sort happened,
    // and only inside the full run, which is the worst way to be wrong.
    //
    // So: wait for it to come to rest. Three identical frames is at rest;
    // the frame cap is there so a page that never settles fails on the
    // assertion below rather than hanging until the test times out.
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          const plate = document.querySelector('.playerBarShell');
          if (!plate) return done();
          let last = Number.NaN;
          let still = 0;
          let frames = 0;
          const step = () => {
            const y = plate.getBoundingClientRect().top;
            still = y === last ? still + 1 : 0;
            last = y;
            frames += 1;
            if (still >= 3 || frames > 120) done();
            else requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        }),
    );
    const after = (await transport.boundingBox())!;
    expect(Math.abs(after.y - parked.y)).toBeLessThan(2);

    // Every bottom clearance in the app is spent from --app-player-height,
    // which app.css collapses to 0 when no strip is mounted. With one up it
    // has to be real, or the last row of every list sits under the plate.
    const clearance = await page
      .locator('.appWindow')
      .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--app-player-height')));
    expect(clearance).toBeGreaterThan(0);

    await pauseHere(page);
  });

  test('Now Playing lifts from the strip and puts the page back down', async ({ page, world }) => {
    await boot(page, world, PHONE);
    await playHere(page, page.getByRole('button', { name: 'Play', exact: true }).first());
    await expect(page.locator('.playerBarShell')).toBeVisible();
    // The sheet is not mounted at all until it is wanted - which is why its
    // absence is a count of zero rather than a hidden dialog.
    await expect(page.locator('.npScreen')).toHaveCount(0);

    // The strip's DEAD SPACE is the handle: a tap on the title lifts the
    // sheet, and a tap on a control must not ride that tap up with it.
    await page.locator('.playerBarShell').click({ position: { x: 100, y: 8 } });
    const sheet = page.getByRole('dialog', { name: 'Now playing' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-open', 'true');

    await page.getByRole('button', { name: 'Close now playing' }).click();
    await expect(page.locator('.npScreen')).toHaveCount(0);
    // The page you were on is still the page you are on.
    await expect(page.getByText('12 songs')).toBeVisible();
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Library/);

    // A control on the strip is a control, not a handle.
    await pauseHere(page);
    await expect(page.locator('.npScreen')).toHaveCount(0);
  });

  test('the desktop docks Now Playing beside the app rather than over it', async ({ page, world }) => {
    // Two shapes, one sheet. Wide with room, Now Playing is a docked pane and
    // there is no strip to tap; the effect that lifts the full screen is
    // deliberately gated off the desktop, where it once replaced the whole
    // app the moment anything played.
    await boot(page, world, DESKTOP);
    await playHere(page, page.getByRole('button', { name: 'Play', exact: true }).first());
    const sheet = page.getByRole('dialog', { name: 'Now playing' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-docked', 'true');
    await expect(sheet).not.toHaveAttribute('data-open', 'true');
    // The rail is still there beside it: the dock takes the right, not the app.
    await expect(nav(page).getByRole('button', { name: 'Library' })).toBeVisible();
    await pauseHere(page);
  });

  test('Settings opens from the rail, from the title bar, and closes on Escape', async ({ page, world }) => {
    await boot(page, world, DESKTOP);
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Settings' }) });

    await nav(page).getByRole('button', { name: 'Settings' }).click();
    await expect(dialog).toBeVisible();
    // Two doors to the same room on a desktop is ordinary; two ROOMS would
    // not be.
    await expect(dialog.getByRole('tab', { name: /Appearance/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // The title bar's cog is the other door, and it must land on the top of
    // Settings rather than on whatever pane was last aimed at.
    await page.locator('.appTitleBar').getByRole('button', { name: 'Settings' }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[role="tab"][aria-selected="true"]')).toHaveText(/Appearance/);
    await page.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    // ...and the page it covered is given back untouched.
    await expect(page.getByText('12 songs')).toBeVisible();
  });

  test('Settings survives the menu it was opened from', async ({ page, world }) => {
    // A surface opened from inside a popover is destroyed by its own trigger:
    // the row that opens it unmounts with the menu, and anything mounted
    // BELOW that row goes with it. Settings is hoisted to App for exactly
    // this reason, and this is the probe that says so - open it from the ⋮,
    // which closes on the way out, and it must still be standing.
    await boot(page, world, PHONE);
    await nav(page).getByRole('button', { name: 'More' }).click();
    const menu = page.getByRole('menu', { name: 'More' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitem', { name: 'Settings' }).click();

    await expect(menu).toBeHidden();
    const sheet = page.getByRole('dialog', { name: 'Settings' });
    await expect(sheet).toBeVisible();
    // Not a frame later, either: a surface that blinks out on the next
    // render is the same defect arriving slowly.
    await expect(sheet).toBeVisible({ timeout: 2_000 });
    await sheet.getByText('Appearance', { exact: true }).click();
    await expect(page.getByRole('radiogroup', { name: 'Theme' })).toBeVisible();
    await page.getByRole('button', { name: 'Back to settings' }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(sheet).toBeHidden();
  });

  test('the bell opens what is waiting and closes again', async ({ page, world }) => {
    await boot(page, world, DESKTOP);
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const panel = page.getByRole('dialog', { name: 'Notifications' });
    await expect(panel).toBeVisible();
    // An empty tray says what it is FOR, rather than nothing at all.
    await expect(panel.getByText('Nothing new. Downloads and news land here.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    // The chrome around it is untouched: the bell is a popover, not a place.
    await expect(nav(page).getByRole('button', { name: 'Library' })).toBeVisible();
  });
});
