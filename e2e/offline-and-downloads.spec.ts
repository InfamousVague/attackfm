/**
 * Songs arriving, songs already here, and the app with its hub taken away.
 *
 * WHERE THE LINE FALLS, said once so no test below pretends otherwise. The
 * device vault - `keep on this device`, the rolling cache, the sweep that
 * must never evict a pin - is Tauri. It reads and writes real files through
 * `src-tauri/src/offline.rs`, and `isTauri()` is false in every browser,
 * including this one. A Playwright context therefore CANNOT download a song
 * to a device, cannot fill a cache and cannot watch a sweep run, and a test
 * that mimed it here would be a test of the mime.
 *
 * What a browser CAN reach, and what this suite is built out of:
 *   - the app's own account of that boundary, in words, on the Downloads &
 *     space pane - which is the contract the browser build makes and the one
 *     thing that would break silently if somebody wired a keep button up to
 *     a vault that is not there;
 *   - the INVISIBLE downloads: a song promised on one device draws a ghost
 *     row wherever it will land, on every device, straight off the hub's
 *     pending-likes ledger. That is server state, so it is fully reachable,
 *     and the ghost/landing hand-off is where this feature has actually
 *     broken;
 *   - the hub going away. Not `setOffline` for the reload case: the bundle
 *     is served over HTTP here (in the shipped app it is local), so killing
 *     the network kills the app itself and the test measures nothing. The
 *     honest shape of this failure - and the one the offline story was
 *     written for - is A HUB THAT DOES NOT ANSWER while the app is fine, so
 *     the hub's origin is routed to an abort and the app is left alone.
 *     `setOffline` still earns its place for the mid-session case, where
 *     there is no reload to survive.
 *
 * The device-cache half is covered by unit tests instead - `cacheSweep`,
 * `cacheQuality`, `cacheHotness`, `filePlan` - which is where a pure
 * function belongs anyway.
 */
import { BEAT, expect, test, type HubApi, type World } from './fixtures/hub.ts';
import { pauseHere, playHere, soloDeck } from './fixtures/deck.ts';
import type { Page } from '@playwright/test';

/** A song nobody's library has, so the promise for it stays a promise. */
const WANTED = { artist: 'Kite Parade', title: 'Harbour Ghost' };

/**
 * Promise a song, and hand back the ledger key the hub filed it under.
 *
 * `key_of` folds the credit and the title the same way the client's
 * `identityKey` does; asking the hub for the answer rather than spelling it
 * here is what keeps the cleanup honest when that folding changes.
 */
async function promise(hub: HubApi, song: { artist: string; title: string }): Promise<string> {
  const filed = await hub.post<{ k: string; landed: boolean }>('/api/likes/pending', song);
  return filed.k;
}

async function forget(hub: HubApi, key: string): Promise<void> {
  await hub.post('/api/likes/pending/remove', { k: key }).catch(() => {});
}

async function pendingKeys(hub: HubApi): Promise<string[]> {
  const ledger = await hub.get<{ pending?: Array<{ k: string }> }>('/api/likes/pending');
  return (ledger.pending ?? []).map((row) => row.k);
}

async function boot(page: Page, world: World, shape = { width: 1280, height: 800 }): Promise<void> {
  await page.setViewportSize(shape);
  // Out of Connect for the duration - see soloDeck. Nothing here is about
  // which device is playing, and a suite that claimed the seat would break
  // the next one that is.
  await soloDeck(page, world);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

/** The Downloads & space pane, which is where the device's own files live. */
async function openStorage(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: /Downloads & space/ }).click();
}

test.describe('songs on their way in', () => {
  test('a promised song draws a ghost row in the list it will land in', async ({ page, hub, world }) => {
    // The whole of "invisible downloads": a download is not a page you go to,
    // the song simply appears where it will live, wearing a spinner. The
    // promise is the hub's, not this device's - which is what makes it show
    // up on every device the account has open, and what makes it testable
    // from a browser that can download nothing.
    const key = await promise(hub, WANTED);
    try {
      await boot(page, world);
      await page.getByRole('button', { name: 'Recent' }).click();

      const ghost = page.locator('[data-ghost]').filter({ hasText: WANTED.title });
      await expect(ghost).toBeVisible();
      // Its subtitle is the STATE, not the artist - a row that only said who
      // it was by would leave "is anything actually happening?" unanswered.
      await expect(ghost).toContainText(WANTED.artist);
      await expect(ghost).toContainText('waiting for its turn');

      // A ghost is not a song. The library's own count is what the hub
      // holds, and a promise must not inflate it - the row is a placeholder
      // for something that is not here.
      await page.getByRole('button', { name: 'Library' }).click();
      await expect(page.getByText('12 songs')).toBeVisible();
    } finally {
      await forget(hub, key);
    }
  });

  test('the ghost is a live handle: its X calls the download off for good', async ({ page, hub, world }) => {
    // The X is not a dismissal of the ROW, it is a withdrawal of the
    // PROMISE - the hub retries a pending like daily, so a row that only
    // hid itself would be back tomorrow. Asserted on both sides of the
    // wire: the row goes here, and the ledger empties there.
    const key = await promise(hub, WANTED);
    let withdrawn = false;
    try {
      await boot(page, world);
      await page.getByRole('button', { name: 'Recent' }).click();
      const ghost = page.locator('[data-ghost]').filter({ hasText: WANTED.title });
      await expect(ghost).toBeVisible();

      await page.getByRole('button', { name: `Stop waiting for ${WANTED.title}` }).click();
      withdrawn = true;
      await expect(ghost).toHaveCount(0);
      await expect.poll(async () => pendingKeys(hub)).not.toContain(key);
    } finally {
      if (!withdrawn) await forget(hub, key);
    }
  });

  test('promising a song the library already holds lands it, and draws no ghost', async ({ page, hub, world }) => {
    // The other end of the same seam, and the shape of a real defect: a
    // promise whose song has arrived must stop being a promise. It used to
    // be matched against the narrow display set rather than against
    // everything the library holds, so a landed song sat in All Songs while
    // its ghost still read "waiting for its turn" for the thirty-day life of
    // the promise - and, matched by the same set, never became a favourite
    // either. Here the hub settles it on the way in and the client has
    // nothing to draw.
    const owned = world.library.tracks[0]!;
    const filed = await hub.post<{ landed: boolean; trackId: number; k: string }>('/api/likes/pending', {
      artist: owned.artist,
      title: owned.title,
    });
    expect(filed.landed).toBe(true);
    try {
      await boot(page, world);
      await page.getByRole('button', { name: /Liked/ }).click();
      // A real row, with everything a song has - not a placeholder.
      await expect(page.getByRole('row').filter({ hasText: owned.title })).toBeVisible();
      await expect(page.locator('[data-ghost]')).toHaveCount(0);
      await expect(await pendingKeys(hub)).not.toContain(filed.k);
    } finally {
      // Unliked through the hub rather than through the row: the next suite
      // inherits this account, and a stray favourite is a stray assertion
      // somewhere else.
      await hub.put(`/api/favorites/${filed.trackId}`, { favorite: false }).catch(() => {});
    }
  });

  test('an empty list with a song on the wire shows the arrival, not "nothing here"', async ({ page, hub, world }) => {
    // The Liked page with nothing liked and one promise outstanding. The
    // page has to say the true thing - it is coming - and it has exactly one
    // way to: draw the ghost instead of the empty state. `hasIncoming`
    // exists for this and nothing else.
    const key = await promise(hub, WANTED);
    try {
      await boot(page, world);
      await page.getByRole('button', { name: /Liked/ }).click();
      await expect(page.locator('[data-ghost]').filter({ hasText: WANTED.title })).toBeVisible();
      // ...and NOT the empty state, which would be a page telling a listener
      // that the song they just kept was never kept.
      await expect(page.getByText(/No liked songs yet/)).toHaveCount(0);
    } finally {
      await forget(hub, key);
    }
  });
});

test.describe('what a browser keeps', () => {
  test('the Downloads & space pane says what this build can and cannot hold', async ({ page, world }) => {
    // The one place the app states the boundary this whole suite is written
    // around. It is a real contract - `canKeep` in the track menu and the
    // song table's on-device column are gated on the same `isTauri()` - and
    // a build that started offering downloads it cannot make would show up
    // here first.
    await boot(page, world);
    await openStorage(page);

    const pane = page.getByRole('tabpanel');
    const view = pane.getByRole('radiogroup', { name: 'Downloads and space' });
    await expect(view).toBeVisible();
    await expect(pane).toContainText(
      'Downloads are kept by the app. A browser tab streams everything from the server.',
    );

    // The file list says it in its own words rather than showing an empty
    // table, which would read as "you have downloaded nothing" instead of
    // "nothing can be downloaded here".
    await view.getByText('Files', { exact: true }).click();
    await expect(pane).toContainText(
      'A browser tab keeps nothing on the device — everything streams from the server.',
    );
  });

  test('a browser never offers to keep a song it cannot keep', async ({ page, world }) => {
    await boot(page, world);
    await page.getByRole('button', { name: 'Recent' }).click();
    const row = page.getByRole('row').nth(1);
    await expect(row).toBeVisible();
    await row.click({ button: 'right' });

    // The menu is real - it has the verbs a row always has...
    const menu = page.getByRole('menu').last();
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Add to playlist' })).toBeVisible();
    // ...and not the one it could only ever fail at.
    await expect(menu.getByRole('menuitem', { name: 'Keep on this device' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // The song table drops the on-device column for the same reason: a whole
    // column that can only ever answer "no" says nothing and costs width.
    await expect(page.getByRole('columnheader', { name: 'On this device' })).toHaveCount(0);
  });
});

test.describe('the hub goes away', () => {
  test('the library is still there, painted from the index this device kept', async ({ page, world }) => {
    // The hub is a box in a house: it goes off, the wifi drops, the plane
    // door closes. The library index lives in IndexedDB on this device and
    // seeds the first render, so the app opens on the music it knows about
    // rather than on a spinner or an apology - and the rows it shows are the
    // REAL cached index, not a placeholder count.
    await boot(page, world);
    await expect(page.getByText('12 songs')).toBeVisible();

    const asked: string[] = [];
    await page.route(`${world.hubUrl}/**`, (call) => {
      asked.push(call.request().url());
      return call.abort();
    });
    await page.reload();

    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByText('12 songs')).toBeVisible();
    // Not just a number: the SONGS. Opened as a list, off the same cache,
    // with real titles in real rows - which is the difference between "the
    // library rendered" and "a count rendered". Only the rows the flow-mode
    // window has drawn are asked for; the point is that they are the
    // fixture's and not placeholders.
    await page.getByRole('button', { name: 'Recent' }).click();
    await expect(page.getByText(/12 songs · /)).toBeVisible();
    const drawn = await page.getByRole('row').evaluateAll((rows) => rows.map((r) => r.textContent ?? ''));
    const known = world.library.tracks
      .map((t) => t.title)
      .filter((title) => drawn.some((row) => row.includes(title)));
    expect(known.length).toBeGreaterThanOrEqual(6);
    // It did ask, and it did get nothing: this is a hub that is gone, not a
    // hub that was never called.
    expect(asked.length).toBeGreaterThan(0);
    // And no page anywhere is wearing a failure. A library you cannot reach
    // right now is better company than an empty one.
    await expect(page.getByText(/Could not reach the server/)).toHaveCount(0);
    await page.unroute(`${world.hubUrl}/**`);
  });

  test('the wall behind the header keeps its sleeves when there are no clips', async ({ page, world }) => {
    // The wall prefers Canvas clips and settles onto album sleeves when a
    // server has none - which is every server that has not been enriched,
    // including this fixture. The failure it must not have is the third
    // option: neither, and a flat white band across the top of the library.
    await boot(page, world);
    const wall = page.locator('.coverWall');
    await expect(wall).toBeVisible();
    await expect.poll(async () => wall.locator('img').count()).toBeGreaterThanOrEqual(3);
    expect(await wall.locator('video').count()).toBe(0);
  });

  test('with the stream unreachable the deck stops honestly rather than pretending', async ({ page, world }) => {
    // Fail-closed: a gate that refuses rather than a spinner that never
    // ends. The recovery ladder is three retries with widening gaps (400 ms,
    // 1.5 s, 4 s) because a dropped connection usually is one - but when the
    // bytes really are not coming the transport gives up, comes back to
    // Play, and says so with a jolt rather than sitting on Pause over
    // silence.
    await boot(page, world, { width: 390, height: 800 });
    await playHere(page, page.getByRole('button', { name: 'Play', exact: true }).first());
    await pauseHere(page);

    await page.route(`${world.hubUrl}/api/stream/**`, (call) => call.abort());
    await page.getByRole('button', { name: 'Play', exact: true }).first().click();

    // Long enough for the whole ladder and the load attempts around it.
    await expect(page.getByRole('button', { name: 'Play', exact: true }).last()).toBeVisible({
      timeout: 25_000,
    });
    await expect
      .poll(async () => page.evaluate(() => document.querySelector('audio')?.paused ?? null), {
        timeout: 25_000,
      })
      .toBe(true);
    // The song is still on the deck - it stopped, it was not thrown away.
    await expect(page.locator('.playerBarShell')).toBeVisible();
    await page.unroute(`${world.hubUrl}/api/stream/**`);
  });

  test('@slow a silent sync that fails does not quietly empty the library', async ({ page, world }) => {
    // Every thirty seconds the library polls its hub for a delta, SILENTLY -
    // no strip, no error, so a settled library costs one tiny request. The
    // silence is the risk: a failed silent pass has nowhere to report to, so
    // if it ever cleared the rows on the way through, an app left open on a
    // hub that went off would empty itself half a minute later with nothing
    // said. This waits out a whole beat of it with the hub aborting, which
    // is the only way to see that pass happen at all.
    await boot(page, world);
    await expect(page.getByText('12 songs')).toBeVisible();

    // Counted narrowly, on the SYNC's own route: the app is chattering to
    // the hub about a dozen other things, and a count of everything would go
    // positive in the first second and never wait for the beat this test is
    // named after.
    let refused = 0;
    await page.route(`${world.hubUrl}/**`, (call) => {
      if (call.request().url().includes('/api/library')) refused += 1;
      return call.abort();
    });
    try {
      // One full idle beat plus the room for the request itself to be made
      // and to fail.
      await expect.poll(() => refused, { timeout: BEAT.POLL_IDLE + 15_000 }).toBeGreaterThan(0);
      await expect(page.getByText('12 songs')).toBeVisible();
      await expect(page.getByRole('main')).toContainText('Recently added');
      // Still no apology on the page: the pass was silent going in and
      // silent coming out.
      await expect(page.getByText(/Could not reach the server/)).toHaveCount(0);
    } finally {
      await page.unroute(`${world.hubUrl}/**`);
    }
  });

  test('the radios going off mid-session does not take the library with them', async ({ page, world }) => {
    // The other offline: no reload, just the network cut under a running
    // app. Nothing may be thrown away - the rows are in memory and the app
    // has no reason to drop them - and the chrome has to stay usable, since
    // half of what somebody does offline is walk around what they already
    // have.
    await boot(page, world);
    await expect(page.getByText('12 songs')).toBeVisible();

    await page.context().setOffline(true);
    try {
      await page.getByRole('button', { name: 'Discover' }).click();
      await page.getByRole('button', { name: 'Library' }).click();
      await expect(page.getByText('12 songs')).toBeVisible();
      await page.getByRole('button', { name: 'Recent' }).click();
      for (const track of world.library.tracks.slice(0, 3)) {
        await expect(page.getByRole('row').filter({ hasText: track.title })).toBeVisible();
      }
    } finally {
      await page.context().setOffline(false);
    }

    // ...and coming back is not a reload: the next sync folds in whatever
    // moved while the radios were off.
    await page.getByRole('button', { name: 'Library' }).click();
    await expect(page.getByText('12 songs')).toBeVisible();
  });
});
