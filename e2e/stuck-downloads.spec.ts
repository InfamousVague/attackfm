/**
 * A song whose download box has gone quiet stops pretending to download.
 *
 * "Downloads get stuck on the all songs list": rows with a spinner that
 * survive restarting the app. They survive because they are not the app's
 * state - an arriving song's row is redrawn every poll from what the HUB says
 * is in flight - and a hub in collector mode hands every download to another
 * box. A song that box took and then slept or crashed on stayed "in flight"
 * for a day, and its cancel was refused because the box had taken it.
 *
 * The hub half (give up once the box has been silent for hours; let a cancel
 * through once it has been quiet for twenty minutes) is pure and has cargo
 * tests in collector.rs. This is the half a person sees: the same arriving
 * song, once with the box calling in and once with it silent.
 */
import { expect, test, type World } from './fixtures/hub.ts';
import { collectorStatus, installFeeds } from './fixtures/feeds.ts';
import { soloDeck } from './fixtures/deck.ts';
import type { Page } from '@playwright/test';

/** A song nobody's library has, so its row can only be the ghost. */
const SONG = { title: 'Harbour Long Gone', artist: 'Nobody Here' };

async function arriving(page: Page, world: World, boxSeenAgoMs: number) {
  await page.setViewportSize({ width: 1280, height: 800 });
  await soloDeck(page, world);
  await installFeeds(page, world, {
    pulls: collectorStatus(world.userIds.matt!, {
      delegates: true,
      downloadsHere: false,
      peerSeenAt: Date.now() - boxSeenAgoMs,
      recent: [{ ...SONG, kind: 'track', state: 'fetching', at: Date.now(), reason: '' }],
    }),
  });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  // The library's song list - every source on the wire, collector finds
  // included, which Liked would filter out.
  await page.getByRole('button', { name: 'Recent' }).click();
  const ghost = page.locator('[data-ghost]').filter({ hasText: SONG.title });
  await expect(ghost).toBeVisible();
  return ghost;
}

test.describe('a delegated download whose box goes quiet', () => {
  test('while the box calls in, the song is downloading', async ({ page, world }) => {
    const ghost = await arriving(page, world, 60_000);
    await expect(ghost).toContainText('downloading');
    await expect(ghost).not.toContainText('waiting for the download box');
  });

  test('once the box has been silent, the row says what it is waiting on', async ({ page, world }) => {
    // An hour: past the twenty minutes the hub waits before it lets a cancel
    // through, and short of the hours it waits before giving the song up.
    const ghost = await arriving(page, world, 60 * 60_000);
    await expect(ghost).toContainText('waiting for the download box');
    await expect(ghost).not.toContainText('downloading');
  });
});
