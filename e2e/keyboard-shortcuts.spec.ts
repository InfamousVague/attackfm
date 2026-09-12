/**
 * The keyboard, in the real app.
 *
 * Unit tests hold the chord arithmetic and the guards against fixture
 * elements. What only the app can prove is that a press reaches the deck that
 * is actually on screen, that the guards see the real focus the app leaves
 * behind - a clicked button keeps it, a field being typed in has it - and that
 * a key changed in Settings is the key the listener answers to.
 */
import { expect, test } from './fixtures/hub.ts';
import { DEVICE, audioState, nowPlaying, openLibrary, pauseHere, sheetTitle, soloDeck } from './fixtures/deck.ts';
import type { Page } from '@playwright/test';

test.use({ afmUser: 'kim' });

const sounding = async (page: Page) => (await audioState(page)).some((a) => !a.paused && a.at > 0);

async function startPlaying(page: Page) {
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect.poll(() => sounding(page), { timeout: 20_000 }).toBe(true);
  await expect(nowPlaying(page)).toBeVisible();
}

test('Space pauses and plays, even straight after a click on a transport button', async ({ page, world }) => {
  await soloDeck(page, world);
  await openLibrary(page, DEVICE.kim);
  await startPlaying(page);

  // Off any control: the page.
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Space');
  await expect.poll(() => sounding(page)).toBe(false);
  await page.keyboard.press('Space');
  await expect.poll(() => sounding(page), { timeout: 10_000 }).toBe(true);

  // THE CASE THAT MATTERS. A button keeps focus after it is clicked, so a
  // guard that yielded Space to any focused button pressed Next again. Clicked
  // with the mouse, then Space: the song must stay and pause.
  await nowPlaying(page).getByRole('button', { name: 'Next', exact: true }).click();
  await expect.poll(() => sounding(page), { timeout: 10_000 }).toBe(true);
  const title = await sheetTitle(page);
  await page.keyboard.press('Space');
  await expect.poll(() => sounding(page)).toBe(false);
  expect(await sheetTitle(page)).toBe(title);

  await page.keyboard.press('Space');
  await expect.poll(() => sounding(page), { timeout: 10_000 }).toBe(true);
  await pauseHere(page);
});

test('a letter typed into search is typed, and / opens search from anywhere', async ({ page, world }) => {
  await soloDeck(page, world);
  await openLibrary(page, DEVICE.kim);
  await startPlaying(page);
  await page.locator('body').click({ position: { x: 5, y: 5 } });

  await page.keyboard.press('/');
  const field = page.getByRole('combobox', { name: 'Search' });
  await expect(field).toBeFocused();
  // Space and S both have actions; in a field they are only characters.
  await page.keyboard.type('s s');
  await expect(field).toHaveValue('s s');
  expect(await sounding(page)).toBe(true);

  await page.keyboard.press('Escape');
  await pauseHere(page);
});

test('a key changed in Settings is the key the app answers to', async ({ page, world }) => {
  await soloDeck(page, world);
  await openLibrary(page, DEVICE.kim);
  await startPlaying(page);

  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  await page.getByText('Keyboard', { exact: true }).first().click();
  const row = page.locator('[data-setting="keyboard-shortcuts"], #keyboard-shortcuts').first();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Change' }).click();
  await page.keyboard.press('k');
  await expect(row.locator('kbd')).toHaveText(['K']);
  await page.keyboard.press('Escape');
  await expect(page.getByText('Keyboard', { exact: true })).toHaveCount(0);

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  // The old key does nothing now...
  await page.keyboard.press('Space');
  await page.waitForTimeout(400);
  expect(await sounding(page)).toBe(true);
  // ...and the new one pauses.
  await page.keyboard.press('k');
  await expect.poll(() => sounding(page)).toBe(false);

  // Put it back for whoever comes next.
  await page.evaluate(() => localStorage.removeItem('attackfm-keymap'));
});
