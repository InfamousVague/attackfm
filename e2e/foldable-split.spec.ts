/**
 * The unfolded shape: Now Playing beside the app, not over it.
 *
 * A foldable opened sideways is about 840 by 700 CSS pixels with a thumb for
 * a pointer. That is the one shape the app had no answer for: it is not a
 * phone (there is room for two rooms), and it is not the desktop (no cursor,
 * so `useDesktopLayout` keeps the phone chrome - the bottom bar, the compact
 * header - which is right). The dock existed, but its floor had been raised
 * to the desktop's 60rem for the rail's sake, and 840 is under it - so the
 * sheet stood over the whole screen and the library behind it was unreachable
 * without putting the song down.
 *
 * Four shapes, measured rather than trusted. A phone in portrait keeps the
 * full-screen sheet; the unfolded screen gets a right-hand column with the
 * phone chrome LIVE on the left; the change happens under an open sheet when
 * the hinge moves, and back; and the desktop (a fine pointer, 60rem) is
 * exactly what it was.
 *
 * `isMobile` + `hasTouch` is what makes Chromium answer `(pointer: coarse)`,
 * which is what a fold does; every scenario below asserts that it did, so a
 * shape that quietly landed on the desktop branch cannot pass as the fold.
 * Both are context options, so the phone scenarios live in their own
 * `describe` with `test.use` rather than resizing a desktop page.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test, type World } from './fixtures/hub.ts';
import { DEVICE, asDevice, nowPlaying, pauseHere, playHere, seekAt, soloDeck } from './fixtures/deck.ts';
import { runRoot } from './fixtures/world.ts';

/*
 * Signed in as ana, on one device, for the reasons DEVICE in fixtures/deck.ts
 * carries: matt's seat must stay cold for the smoke that runs after, and a
 * fresh device id per test would open the second test as a watcher.
 */
test.use({ afmUser: 'ana' });

/** An ordinary phone held upright. */
const PHONE = { width: 390, height: 844 };
/** A foldable's inner screen, open and sideways. */
const FOLD = { width: 840, height: 700 };
/** Past 60rem with a fine pointer: the rail, the title bar, the desktop dock. */
const DESKTOP = { width: 1280, height: 800 };

/**
 * Where the screenshots go. Each shape is photographed once, so a person can
 * look at what the numbers below are describing; the frames are evidence, not
 * assertions - a pixel diff would go red on every font change.
 */
const SHOTS = process.env.AFM_E2E_SHOTS ?? join(runRoot(), 'shots', 'fold-split');

const nav = (page: Page): Locator => page.getByRole('navigation', { name: 'Primary' });

/** Boot signed in with the library painted, out of Connect for the duration. */
async function boot(page: Page, world: World): Promise<void> {
  await soloDeck(page, world);
  await asDevice(page, DEVICE.ana);
  await page.goto('/');
  await expect(nav(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Library' })).toBeVisible();
}

/** Start the shelf playing; the transport's own Play shares the name, hence `first`. */
async function startTheMusic(page: Page): Promise<void> {
  await playHere(page, page.getByRole('button', { name: 'Play', exact: true }).first());
}

/** Whether this page answers to a thumb, which is what a fold and a phone do. */
async function coarsePointer(page: Page): Promise<boolean> {
  return page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
}

interface Frame {
  /** What the app thinks the window is - `isMobile` can report a layout viewport wider than the screen. */
  viewport: { width: number; height: number };
  sheet: { left: number; right: number; top: number; bottom: number; width: number } | null;
  docked: boolean;
  open: boolean;
  /** The phone chrome's boxes, or null where that shape is not worn. */
  navBar: { left: number; right: number } | null;
  header: { left: number; right: number } | null;
  rail: boolean;
  /** Whether the strip is still on screen; docked, it must not be. */
  strip: boolean;
}

/** One read of the whole layout, in one trip, so nothing moves between the numbers. */
async function frame(page: Page): Promise<Frame> {
  return page.evaluate(() => {
    const box = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
    };
    const sheet = document.querySelector('.npScreen');
    const strip = document.querySelector('.playerBarShell');
    const stripBox = strip ? strip.getBoundingClientRect() : null;
    const navBar = box(document.querySelector('.appNavBar'));
    const header = box(document.querySelector('.mobileHeader'));
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      sheet: box(sheet),
      docked: !!sheet?.hasAttribute('data-docked'),
      open: !!sheet?.hasAttribute('data-open'),
      navBar: navBar && { left: navBar.left, right: navBar.right },
      header: header && { left: header.left, right: header.right },
      rail: !!document.querySelector('.appNavRail'),
      strip: !!stripBox && stripBox.width > 0 && stripBox.height > 0,
    };
  });
}

test.beforeAll(() => {
  mkdirSync(SHOTS, { recursive: true });
});

test.describe('a phone in portrait', () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  test('Now Playing is the whole screen', async ({ page, world }) => {
    await boot(page, world);
    expect(await coarsePointer(page)).toBe(true);
    await startTheMusic(page);

    // The sheet is lifted from the strip's dead space, exactly as a listener
    // does it, and nothing about the phone has changed: no dock, full width.
    await page.locator('.playerBarShell').click({ position: { x: 100, y: 8 } });
    await expect(nowPlaying(page)).toBeVisible();

    const f = await frame(page);
    expect(f.viewport.width).toBe(PHONE.width);
    expect(f.open).toBe(true);
    expect(f.docked).toBe(false);
    expect(f.sheet?.left).toBe(0);
    expect(f.sheet?.width).toBe(PHONE.width);

    await page.screenshot({ path: join(SHOTS, 'a-phone-portrait.png') });
    await page.getByRole('button', { name: 'Close now playing' }).click();
    await pauseHere(page);
  });
});

test.describe('unfolded and sideways', () => {
  test.use({ viewport: FOLD, isMobile: true, hasTouch: true });

  test('Now Playing takes a column, and the app stays live beside it', async ({ page, world }) => {
    await boot(page, world);
    expect(await coarsePointer(page)).toBe(true);
    // The phone chrome, because this is a thumb-driven screen: the bottom
    // bar, the compact header, and no rail.
    const before = await frame(page);
    expect(before.viewport.width).toBe(FOLD.width);
    expect(before.navBar).not.toBeNull();
    expect(before.header).not.toBeNull();
    expect(before.rail).toBe(false);

    await startTheMusic(page);
    // Docked the moment something is engaged - nobody has to lift it.
    const sheet = nowPlaying(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-docked', 'true');

    const f = await frame(page);
    expect(f.sheet).not.toBeNull();
    // A column down the RIGHT, narrower than the screen, and a sane one: at
    // least a phone's width for the art, and never more than half the screen
    // - the app keeps the wider half.
    expect(f.sheet!.width).toBeLessThan(FOLD.width / 2);
    expect(f.sheet!.width).toBeGreaterThanOrEqual(300);
    expect(f.sheet!.right).toBeLessThanOrEqual(FOLD.width);
    expect(f.sheet!.left).toBeGreaterThan(FOLD.width / 2);
    // The phone chrome stays, and stays OUT from under the column: the bar
    // and the header both end where the dock begins.
    expect(f.rail).toBe(false);
    expect(f.navBar).not.toBeNull();
    expect(f.navBar!.right).toBeLessThanOrEqual(f.sheet!.left);
    expect(f.header).not.toBeNull();
    expect(f.header!.right).toBeLessThanOrEqual(f.sheet!.left);
    // With the whole player standing in the column the strip would be the
    // same transport twice.
    expect(f.strip).toBe(false);

    await page.screenshot({ path: join(SHOTS, 'b-fold-split.png') });

    // The left side is a working app, not a picture of one: a tab is tapped
    // and the page underneath changes while the song stays docked.
    await nav(page).getByRole('button', { name: 'Discover' }).click();
    await expect.poll(async () => nav(page).locator('[aria-current="page"]').count()).toBe(1);
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Discover/);
    await expect(sheet).toHaveAttribute('data-docked', 'true');
    await nav(page).getByRole('button', { name: 'Library' }).click();
    await expect(nav(page).locator('[aria-current="page"]')).toHaveText(/Library/);
    await expect(page.getByText('12 songs')).toBeVisible();

    // And the column is a working player: the seek control answers, and the
    // queue opens inside the column rather than across the screen.
    const seek = sheet.getByRole('slider', { name: 'Seek' });
    await expect.poll(async () => seekAt(seek), { timeout: 15_000 }).toBeGreaterThan(0.5);
    await sheet.getByRole('button', { name: 'Queue' }).click();
    const queue = page.locator('.npScreen__queueView');
    await expect(queue).toBeVisible();
    const queueBox = await queue.boundingBox();
    expect(queueBox!.x).toBeGreaterThanOrEqual(f.sheet!.left);
    expect(queueBox!.x + queueBox!.width).toBeLessThanOrEqual(f.sheet!.right + 1);
    await page.screenshot({ path: join(SHOTS, 'b-fold-split-queue.png') });
    await queue.getByRole('button', { name: 'Close queue' }).click();
    await expect(queue).toHaveCount(0);

    await pauseHere(page);
  });
});

test.describe('the hinge, with the sheet up', () => {
  test.use({ viewport: PHONE, isMobile: true, hasTouch: true });

  test('unfolding splits the open sheet in place, and folding puts it back', async ({ page, world }) => {
    await boot(page, world);
    expect(await coarsePointer(page)).toBe(true);
    await startTheMusic(page);
    await page.locator('.playerBarShell').click({ position: { x: 100, y: 8 } });
    const sheet = nowPlaying(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-open', 'true');
    expect((await frame(page)).sheet?.width).toBe(PHONE.width);

    // The hinge opens. The media query flips, and the sheet that is already
    // standing becomes the column - no reopen, no reload.
    await page.setViewportSize(FOLD);
    await expect.poll(async () => (await frame(page)).viewport.width).toBe(FOLD.width);
    await expect(sheet).toHaveAttribute('data-docked', 'true');
    await expect.poll(async () => (await frame(page)).sheet?.width ?? 0).toBeLessThan(FOLD.width / 2);
    const open = await frame(page);
    expect(open.sheet!.left).toBeGreaterThan(FOLD.width / 2);
    expect(open.navBar!.right).toBeLessThanOrEqual(open.sheet!.left);
    // Still the phone's chrome - unfolding did not turn the device into a desktop.
    expect(open.rail).toBe(false);
    await expect(nav(page).getByRole('button', { name: 'Library' })).toBeVisible();
    await page.screenshot({ path: join(SHOTS, 'c-unfolded-live.png') });

    // And closes. The column becomes the sheet it was, still up, full width.
    await page.setViewportSize(PHONE);
    await expect.poll(async () => (await frame(page)).viewport.width).toBe(PHONE.width);
    await expect(sheet).not.toHaveAttribute('data-docked', 'true');
    await expect(sheet).toHaveAttribute('data-open', 'true');
    await expect.poll(async () => (await frame(page)).sheet?.width ?? 0).toBe(PHONE.width);
    await page.screenshot({ path: join(SHOTS, 'c-folded-back.png') });

    await page.getByRole('button', { name: 'Close now playing' }).click();
    await pauseHere(page);
  });
});

test.describe('the desktop', () => {
  test('is exactly what it was: rail, title bar, and the dock beside them', async ({ page, world }) => {
    // The project's default context is Desktop Chrome: a fine pointer, no
    // touch. That is the shape `useDesktopLayout` answers yes to, and nothing
    // in the fold's arrival is allowed to move it.
    await page.setViewportSize(DESKTOP);
    await boot(page, world);
    expect(await coarsePointer(page)).toBe(false);
    await startTheMusic(page);
    const sheet = nowPlaying(page);
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-docked', 'true');
    await expect(sheet).not.toHaveAttribute('data-open', 'true');

    // The sheet rises in over 0.28s; a box read mid-rise is a box mid-rise.
    await expect
      .poll(async () => page.evaluate(() => document.querySelector('.npScreen')?.getAnimations().length ?? -1))
      .toBe(0);
    const f = await frame(page);
    // Written before anything is asserted, so a red here still leaves the
    // numbers behind for whoever has to compare them against the last green.
    writeFileSync(join(SHOTS, 'd-desktop.json'), JSON.stringify(f, null, 2));
    expect(f.viewport.width).toBe(DESKTOP.width);
    expect(f.rail).toBe(true);
    expect(f.navBar).toBeNull();
    expect(f.header).toBeNull();
    expect(f.strip).toBe(false);
    // The desktop's own dock arithmetic, as measured on the build before the
    // fold's split landed: `min(38vw, 32rem)` less the card's margin on each
    // side, hung under the 3.25rem title bar. Written out so a change to the
    // desktop's numbers is a red here rather than a surprise on a Mac.
    const margin = DESKTOP.width - f.sheet!.right;
    expect(margin).toBeGreaterThan(8);
    expect(margin).toBeLessThan(24);
    expect(f.sheet!.width).toBeCloseTo(Math.min(0.38 * DESKTOP.width, 32 * 16) - 2 * margin, 0);
    expect(f.sheet!.top).toBeCloseTo(margin + 3.25 * 16, 0);
    await expect(nav(page).getByRole('button', { name: 'Library' })).toBeVisible();

    await page.screenshot({ path: join(SHOTS, 'd-desktop.png') });
    await pauseHere(page);
  });
});
