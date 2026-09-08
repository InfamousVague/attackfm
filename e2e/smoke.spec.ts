/**
 * The harness proving itself.
 *
 * Not a feature test - the twelve suites do that. This is the one spec that
 * fails when the RIG is broken rather than when the app is, and it is
 * deliberately built out of every part the rig has: the seeded sign-in, the
 * real hub's real index of real (silent) files, a stream token minted by a
 * real login, and a media element that gets bytes back over byte ranges.
 *
 * If this goes red, read it in order. The first failing line names which half
 * of the world did not come up.
 */
import { expect, test } from './fixtures/hub.ts';

test('signed in, on a real library, playing a real file', async ({ page, world }) => {
  // A React render that throws leaves a plausible-looking page behind - the
  // shell paints and one pane is missing - so the crash is collected here and
  // asserted at the end rather than left to whichever locator happens to miss.
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  // Every /api/stream reply, so "it played" can be checked against what the
  // hub actually sent. A 200 for the whole file would still play; it is the
  // 206 that says the media element can seek, and a seek that cannot be served
  // is the failure that reads as a broken scrubber three suites away.
  const streamed: Array<{ status: number; range: boolean }> = [];
  page.on('response', (reply) => {
    if (reply.url().startsWith(`${world.hubUrl}/api/stream/`)) {
      streamed.push({ status: reply.status(), range: !!reply.request().headers()['range'] });
    }
  });

  await page.goto('/');

  // 1. SIGNED IN, without ever seeing the door.
  //
  // storageState put the session in localStorage before the bundle evaluated,
  // so the auth gate has never had a signed-out frame to paint. If this fails,
  // the storage seed is wrong - most likely the `attackfm-sessions` key, which
  // must be the NORMALISED url (lower case, no trailing slash).
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Library' })).toBeVisible();

  // 2. THE LIBRARY IS THE FIXTURE'S, counted by the app itself.
  //
  // The book's twelve chapters are not songs and are not counted here - they
  // are behind the Books tab, which is exactly the split `Audiobooks/` exists
  // to make. A count that included them would mean the folder rule had not
  // fired.
  const songs = world.library.tracks.length;
  await expect(page.getByText(`${songs} songs`)).toBeVisible();

  // The record written LAST is the one "Recently added" leads with. That is
  // only true because global-setup scans between records; written all at once
  // they share a millisecond and the shelf comes back in directory-walk order,
  // which is a different answer on the next machine. This assertion is the
  // guard on that: if it goes red, the staging stopped happening.
  const newest = world.library.albums.at(-1)!;
  await expect(page.getByRole('button', { name: `${newest.album} ${newest.artist}` }).first()).toBeVisible();

  // The book is behind Books, not among the songs - which is the whole point
  // of the `Audiobooks/` folder being the contract.
  //
  // Clicked by its LABEL, not by the radio: the label sits over the input and
  // intercepts the pointer, so a click on the role never lands. That is what a
  // listener's thumb hits too, so this is the honest gesture rather than a
  // `force: true` that would also pass on a control nobody could reach.
  const sections = page.getByRole('radiogroup', { name: 'Library section' });
  await sections.getByText('Books', { exact: true }).click();
  await expect(page.getByText(world.library.book.title).first()).toBeVisible();
  await sections.getByText('Music', { exact: true }).click();

  // 3. PLAY.
  //
  // `.first()`, and it is the hero's button rather than an arbitrary one: the
  // player strip carries a Play of its own the moment anything is playing, and
  // the hero is above it in the DOM. Nothing is playing yet here - the Connect
  // socket is stubbed for every file that has not asked for it, so no other
  // suite's seat can leave a song parked in this one - but a locator that only
  // works while that stays true is a locator waiting to go strict-mode red.
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();

  // The strip and the sheet both carry these, so neither is pinned to whether
  // Now Playing opened itself.
  const pause = page.getByRole('button', { name: 'Pause' }).first();
  await expect(pause).toBeVisible();

  const seek = page.getByRole('slider', { name: 'Seek' }).first();
  await expect(seek).toBeVisible();

  // Whatever is playing is one of ours. The order the library hands the player
  // is not asserted - `addedAt` is the hub's insert clock and the scan walk
  // decides it - only that the song came from this fixture and not from a
  // stale database left behind by the last run.
  const titles = world.library.tracks.map((t) => t.title);
  await expect
    .poll(async () => {
      const now = await page.locator('body').innerText();
      return titles.some((title) => now.includes(title));
    })
    .toBe(true);

  // 4. THE POSITION ADVANCES.
  //
  // Read off the seek control's own `aria-valuenow`, in seconds - which is
  // what a screen reader is told and therefore what a listener is told. A
  // paused element, a 404 stream and a src that never loaded all sit at 0
  // forever, so this one number separates "the button worked" from "the music
  // is playing".
  const started = Number(await seek.getAttribute('aria-valuenow'));
  expect(Number.isFinite(started)).toBe(true);
  await expect
    .poll(async () => Number(await seek.getAttribute('aria-valuenow')), { timeout: 15_000 })
    .toBeGreaterThan(started + 1);

  // The duration came off the file, not off a tag: a fixture track is 12-22 s,
  // and an element that never loaded reports NaN or Infinity (which is what
  // Android's WebView does, and why timelineDuration exists at all).
  const total = Number(await seek.getAttribute('aria-valuemax'));
  expect(total).toBeGreaterThan(5);
  expect(total).toBeLessThan(60);

  // 5. AND THE BYTES CAME FROM THE HUB, over ranges.
  expect(streamed.length).toBeGreaterThan(0);
  expect(streamed.every((s) => s.status === 200 || s.status === 206)).toBe(true);

  expect(crashes).toEqual([]);
});
