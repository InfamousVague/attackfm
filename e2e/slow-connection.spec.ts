/**
 * A slow connection plays the copy this device already holds.
 *
 * A song with a sound effect on is rendered by the hub, so the copies of it on
 * the device - the vault's, the queue buffer's - are deliberately passed over
 * in the hub's favour. That trade was only ever undone for a hub that had
 * stopped answering, and a SLOW connection never looks like that: its requests
 * come back, late, and a starving media element fires `waiting`, never
 * `error`. So a held song with a filter on sat buffering, retried the stream
 * that could not keep up, and stopped - on a song sitting whole on the disk.
 *
 * The connection is made slow the way that matters here: the coloured stream
 * for the next song never arrives at all. That is also the case the stall
 * ladder cannot see - a first load waits on `canplay` with a paused element,
 * and `stalled` on a paused element is ignored - so this is the first-load
 * watch doing the work, noting the strain, and the retry landing on the copy.
 *
 * The copy under test is the queue buffer's, which is what a browser holds;
 * the app's vault answers through the same gate on a phone.
 */
import { expect, test } from './fixtures/hub.ts';
import {
  DEVICE,
  audioState,
  closeSoundConsole,
  openLibrary,
  openSoundConsole,
  pauseHere,
  soloDeck,
  tapFilter,
} from './fixtures/deck.ts';
import type { Page } from '@playwright/test';

test.use({ afmUser: 'kim' });

/** What the queue buffer holds, by library path - read off the store itself. */
async function buffered(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    if (typeof caches === 'undefined') return [];
    const store = await caches.open('attackfm-queue-v1');
    const origin = 'https://queue.attackfm.local/';
    return (await store.keys()).map((r) => decodeURIComponent(r.url.slice(origin.length)));
  });
}

test('a held song with a filter on plays its saved copy when the stream cannot arrive', async ({ page, world }) => {
  await soloDeck(page, world);
  await openLibrary(page, DEVICE.kim);
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect
    .poll(async () => (await audioState(page)).some((a) => !a.paused && a.at > 0), { timeout: 20_000 })
    .toBe(true);

  // The window ahead fills a couple of seconds into a song, one file at a
  // time. The song after this one is what the skip below will reach.
  await expect.poll(async () => (await buffered(page)).length, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);

  // A filter, through the console's own door. From here every song is the
  // hub's to render, and the buffer's dry copies are passed over.
  await openSoundConsole(page);
  await tapFilter(page, 'Telephone');
  await closeSoundConsole(page);
  await expect
    .poll(async () => (await audioState(page)).some((a) => a.src.includes('/api/transcode/') && a.src.includes('fx2=')), {
      timeout: 20_000,
    })
    .toBe(true);

  // THE SLOW CONNECTION. Every coloured stream from here on is asked for and
  // never answered.
  let asked = 0;
  await page.route(/\/api\/transcode\//, async () => {
    asked += 1;
    await new Promise(() => {});
  });

  const titleBefore = await page.locator('.npScreen__title, .playerBarShell .trackInfo__title').first().innerText().catch(() => '');
  await page.getByRole('button', { name: /^Next( track)?$/ }).first().click();

  // The hub was asked - the gate still prefers it, which is right until it
  // fails - and then the song plays anyway, off the copy, from a blob.
  await expect.poll(() => asked, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect
    .poll(
      async () => (await audioState(page)).some((a) => a.src.startsWith('blob:') && !a.paused && a.at > 0.3),
      { timeout: 20_000 },
    )
    .toBe(true);

  // It is the NEXT song, not one skipped past on the way to something held.
  const titleAfter = await page.locator('.npScreen__title, .playerBarShell .trackInfo__title').first().innerText().catch(() => '');
  if (titleBefore) expect(titleAfter).not.toBe(titleBefore);

  // And the listener is told their filter is not on this copy.
  await expect(page.getByText(/connection can’t keep up/)).toBeVisible();

  // Still playing a few seconds on: the copy is not handed back to the stream.
  const at = (await audioState(page)).find((a) => a.src.startsWith('blob:') && !a.paused)?.at ?? 0;
  await expect
    .poll(async () => (await audioState(page)).find((a) => a.src.startsWith('blob:') && !a.paused)?.at ?? 0, {
      timeout: 10_000,
    })
    .toBeGreaterThan(at + 1.5);

  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await pauseHere(page);
});
