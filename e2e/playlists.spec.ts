/**
 * Playlists: the one thing in this app a person MAKES.
 *
 * Everything else the library shows is a fact about their music - what they
 * own, when it arrived, what they played. A playlist is an opinion, and every
 * assertion here is about that opinion surviving: the order it was filed in
 * beating any sort that would look tidier, a drag surviving a relaunch, a
 * cleared description reading as cleared rather than as an empty string kept
 * somewhere, a list the server generated staying out of the picker for the
 * lists a person keeps, and a friend's addition arriving in the owner's copy.
 *
 * Fixture: `hub-two-users` - matt owns the lists, kim is a friend on the same
 * hub, and the second half of the file drives both at once.
 *
 * ONE HUB SERVES EVERY SUITE, and a playlist made here outlives this file. All
 * of them are named with one prefix and swept in `afterEach`, whether the test
 * that made them finished or died halfway.
 */
import { contextAs, expect, test, type HubApi, type World } from './fixtures/hub.ts';
import { hubPlaylists, noConnect, playingTitle, rowMenuItem, sweepPlaylists } from './fixtures/playlists.ts';
import type { Browser, Page } from '@playwright/test';

/** Every list this file makes wears it, and the sweep takes anything that does. */
const MINE = 'E2E-B ';

/**
 * A real, minimal JPEG - one grey pixel, base64.
 *
 * The cover path goes all the way to the hub, which stores the bytes and hands
 * back a url. Anything that is not an image would be testing the refusal path
 * without meaning to, and generating one with ffmpeg inside a spec would put a
 * second copy of the fixture generator here.
 */
const TINY_JPEG =
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

/** The fixture's twelve, by who made them - see the same table in the library suite. */
const ARTIST_OF: Readonly<Record<string, string>> = {
  'Margin Sketch': 'The Quiet Ledger',
  'Ink and Weather': 'The Quiet Ledger',
  'Ledger Line': 'The Quiet Ledger',
  'Slate Rooftops': 'Nova Static',
  'Paper Lantern': 'Nova Static',
  'Signal Fade': 'Nova Static',
  'Harbour Lights': 'Nova Static',
  Kindling: 'Nova Static',
  'Copper Wire': 'Nova Static',
  'Ember Days': 'Nova Static',
  'Fountain Pen Blues': 'Marla Vane',
  Longhand: 'Marla Vane',
};
const artistOf = (title: string): string => {
  const artist = ARTIST_OF[title];
  if (!artist) throw new Error(`e2e: no fixture artist for "${title}"`);
  return artist;
};

async function openLibrary(page: Page): Promise<void> {
  // See `noConnect`: without it a page is a Connect device, and the seat the
  // previous context left behind makes this one a remote of a ghost.
  await noConnect(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

/** "Recently added" as a table of every fixture song. */
async function openRecent(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Recent/ }).first().click();
  await expect(page.getByRole('grid', { name: 'Songs' })).toBeVisible();
}

/** The New-playlist sheet, filled in and committed. Lands on the new page. */
async function makePlaylist(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: /New Playlist/ }).first().click();
  await page.getByRole('textbox', { name: 'Playlist name' }).fill(name);
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** File one song into one list through the song's own menu. */
async function fileSong(page: Page, title: string, list: string): Promise<void> {
  await rowMenuItem(page, title, artistOf(title), 'Add to playlist…');
  const sheet = page.getByRole('dialog', { name: 'Add to playlist' });
  await expect(sheet).toBeVisible();
  const row = sheet.getByRole('button', { name: new RegExp(list) });
  await row.click();
  // The row's pressed state IS "the song is in this list" - waiting on it
  // rather than on the sheet closing is what makes the next step safe.
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
}

/** Open a list from the Library's playlist grid. */
async function openPlaylist(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('button', { name: new RegExp(name) }).first().click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
}

/** The rows of the open playlist, in the order it is showing them. */
async function listedTitles(page: Page): Promise<string[]> {
  return page.locator('.songTitle__name').allInnerTexts();
}

/** One list, as the hub holds it. */
async function listOnHub(hub: HubApi, name: string) {
  const found = (await hubPlaylists(hub)).find((p) => p.name === name);
  if (!found) throw new Error(`e2e: no playlist called "${name}" on the hub`);
  return found;
}

/** A second signed-in browser - a friend, or this account in another window. */
async function secondPerson(browser: Browser, world: World, who: string) {
  const context = await contextAs(browser, world, who);
  const page = await context.newPage();
  // Out of Connect for the same reason the first one is: neither of these two
  // windows is meant to be the other's remote, and a second matt window that
  // registered as a device would be exactly that.
  await noConnect(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  return { context, page };
}

test.afterEach(async ({ hub }) => {
  await sweepPlaylists(hub, MINE);
});

test('a new list is filled from a song menu and plays in the order it was filed', async ({ page, hub }) => {
  const name = `${MINE}Filed`;
  await openLibrary(page);
  await makePlaylist(page, name);
  await expect(page.getByText('0 songs')).toBeVisible();

  /*
   * Filed in an order that is NOT alphabetical, on purpose.
   *
   * A playlist is a running order somebody wrote down, and the song table it
   * is drawn with sorts alphabetically by default everywhere else. The page
   * has to pass `defaultSort={null}` for this to hold - and if it ever stops,
   * a list reads as tidy and plays in the wrong order, which is the quietest
   * possible way to lose the only thing the list was.
   */
  const filed = ['Slate Rooftops', 'Kindling', 'Margin Sketch'];
  await page.getByRole('button', { name: 'Library' }).click();
  await openRecent(page);
  for (const title of filed) await fileSong(page, title, name);

  await openPlaylist(page, name);
  await expect(page.getByText(/^3 songs · /)).toBeVisible();
  expect(await listedTitles(page)).toEqual(filed);
  // And the hub holds the same order, so it is the LIST that is ordered rather
  // than this one render of it.
  expect((await listOnHub(hub, name)).tracks?.length).toBe(3);

  // Play from the top: the first row, then the second - the list as filed.
  await page.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect.poll(() => playingTitle(page)).toBe(filed[0]);
  await page.getByRole('button', { name: 'Pause' }).first().click();
  await page.getByRole('button', { name: 'Next', exact: true }).first().click();
  await expect.poll(() => playingTitle(page)).toBe(filed[1]);
});

test('a second tap on the same list takes the song back out', async ({ page }) => {
  const name = `${MINE}Toggle`;
  await openLibrary(page);
  await makePlaylist(page, name);
  await page.getByRole('button', { name: 'Library' }).click();
  await openRecent(page);
  await fileSong(page, 'Kindling', name);

  /*
   * One tap adds, a second tap on the same row removes - and the ONLY thing
   * separating the two outcomes is a check mark, so the row's pressed state is
   * the whole contract. Asserted from the picker rather than from the page,
   * because the picker is where the mistake would be made.
   */
  await rowMenuItem(page, 'Kindling', artistOf('Kindling'), 'Add to playlist…');
  const sheet = page.getByRole('dialog', { name: 'Add to playlist' });
  const row = sheet.getByRole('button', { name: new RegExp(name) });
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'false');
  await sheet.getByRole('button', { name: 'Close' }).click();

  await openPlaylist(page, name);
  // An empty list says what to do next rather than showing an empty table.
  await expect(page.getByText(/^Nothing here yet\./)).toBeVisible();
});

test('Add all on a collection page files the whole page', async ({ page, world }) => {
  const name = `${MINE}Whole`;
  await openLibrary(page);
  await makePlaylist(page, name);
  await page.getByRole('button', { name: 'Library' }).click();
  await openRecent(page);

  // The other door onto the same picker: a page's own "Add all", which files
  // every row it is showing rather than the one under the finger.
  await page.getByRole('button', { name: 'Add all' }).click();
  const sheet = page.getByRole('dialog', { name: 'Add to playlist' });
  await expect(sheet).toBeVisible();
  const row = sheet.getByRole('button', { name: new RegExp(name) });
  await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await sheet.getByRole('button', { name: 'Close' }).click();

  await openPlaylist(page, name);
  await expect(page.getByText(`${world.library.tracks.length} songs`).first()).toBeVisible();
});

test('the hand-written order survives a drag and a relaunch', async ({ page, hub }) => {
  const name = `${MINE}Order`;
  const tracks = await hub.tracks();
  const idOf = (title: string) => tracks.find((t) => t.title === title)!.id as number;
  const filed = ['Slate Rooftops', 'Kindling', 'Margin Sketch'];
  await hub.post('/api/playlists', { name, tracks: filed.map(idOf) });

  await openLibrary(page);
  await openPlaylist(page, name);
  expect(await listedTitles(page)).toEqual(filed);

  /*
   * Moved from the keyboard, which is the gesture the kit's SortableList makes
   * first-class: Space lifts the row, an arrow moves it, Space drops it. It
   * resolves through the same `moveItem` a pointer drag does, so a row dropped
   * in the second slot lands in the second slot either way - and it cannot
   * half-happen the way a synthetic drag can.
   */
  await page.getByRole('button', { name: 'Reorder' }).click();
  const handle = page.getByRole('button', { name: `Reorder ${filed[0]}` });
  await handle.focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Done' }).click();

  const moved = [filed[1]!, filed[0]!, filed[2]!];
  await expect.poll(() => listedTitles(page)).toEqual(moved);

  // The hub was told, and the page comes back to the same order from a cold
  // start - a reorder that only lived in this render would pass the assertion
  // above and lose the list at the next launch.
  await expect
    .poll(async () => (await listOnHub(hub, name)).tracks)
    .toEqual(moved.map(idOf));
  // A relaunch, and back in through the shelf: the nav stack is not in the
  // URL, so a reload lands on the Library rather than on this page - which is
  // the honest way back to it anyway.
  await page.reload();
  await openPlaylist(page, name);
  await expect.poll(() => listedTitles(page)).toEqual(moved);
});

test('a row is removed, and the undo puts it back', async ({ page, hub }) => {
  const name = `${MINE}Remove`;
  const tracks = await hub.tracks();
  const idOf = (title: string) => tracks.find((t) => t.title === title)!.id as number;
  const filed = ['Slate Rooftops', 'Kindling', 'Margin Sketch'];
  await hub.post('/api/playlists', { name, tracks: filed.map(idOf) });

  await openLibrary(page);
  await openPlaylist(page, name);

  // The row's own verb, named for the song it takes out.
  await page.getByRole('button', { name: 'Remove Kindling' }).click();
  await expect.poll(() => listedTitles(page)).toEqual(['Slate Rooftops', 'Margin Sketch']);

  /*
   * And the way back. Taking a song out of a list is the one edit here with no
   * other record of it - the song is still in the library, so nothing on
   * screen would show that the list has lost it - which is why the toast
   * carries an undo rather than a confirmation.
   */
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => listedTitles(page)).toEqual(filed);
  await expect.poll(async () => (await listOnHub(hub, name)).tracks?.length).toBe(3);
});

test('renaming it renames it everywhere, and deleting it walks you out', async ({ page, hub }) => {
  const before = `${MINE}Before`;
  const after = `${MINE}After`;
  const tracks = await hub.tracks();
  await hub.post('/api/playlists', { name: before, tracks: [tracks[0]!.id] });

  await openLibrary(page);
  await openPlaylist(page, before);
  await page.getByRole('button', { name: 'Playlist actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename playlist' });
  await rename.getByRole('textbox', { name: 'Playlist name' }).fill(after);
  await rename.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('heading', { name: after })).toBeVisible();
  await expect.poll(async () => (await hubPlaylists(hub)).map((p) => p.name)).toContain(after);
  // The shelf agrees, which is the half a rename that only touched the page
  // would fail.
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByRole('button', { name: new RegExp(after) }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(before) })).toHaveCount(0);

  // Deleting from the page it is open on: the confirmation names the list and
  // says what survives it, and the page steps back rather than standing on a
  // list that is gone.
  await page.getByRole('button', { name: new RegExp(after) }).first().click();
  await page.getByRole('button', { name: 'Playlist actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Delete playlist' }).click();
  const confirm = page.getByRole('dialog', { name: `Delete “${after}”?` });
  await expect(confirm).toContainText('The songs stay in your library');
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();

  await expect(page.getByRole('heading', { name: after })).toHaveCount(0);
  await expect.poll(async () => (await hubPlaylists(hub)).map((p) => p.name)).not.toContain(after);
  // The songs really did stay.
  await expect(page.getByRole('button', { name: /^Recent/ }).first()).toBeVisible();
});

test('a description survives a relaunch, and clearing it clears it', async ({ page, hub }) => {
  const name = `${MINE}About`;
  const tracks = await hub.tracks();
  await hub.post('/api/playlists', { name, tracks: [tracks[0]!.id] });

  await openLibrary(page);
  await openPlaylist(page, name);
  await page.getByRole('button', { name: 'Add a description' }).click();
  const field = page.getByRole('textbox', { name: 'Playlist description' });
  await field.fill('Songs for a long drive');
  await field.blur();

  await expect.poll(async () => (await listOnHub(hub, name)).description).toBe('Songs for a long drive');
  await page.reload();
  await openPlaylist(page, name);
  await expect(page.getByText('Songs for a long drive')).toBeVisible();

  /*
   * And clearing it is a real value, not "unchanged".
   *
   * An empty description has to be expressible or there is no way back from
   * one typed by mistake - the button that offers to add one has to return.
   * The device-side meta store must not be holding an empty string either:
   * that store exists only to carry decoration written before hubs could keep
   * it, and an empty entry there would be migrated forward forever.
   */
  await page.getByText('Songs for a long drive').click();
  await page.getByRole('textbox', { name: 'Playlist description' }).fill('');
  await page.getByRole('textbox', { name: 'Playlist description' }).blur();
  await expect.poll(async () => (await listOnHub(hub, name)).description).toBe('');
  await page.reload();
  await openPlaylist(page, name);
  await expect(page.getByRole('button', { name: 'Add a description' })).toBeVisible();
  // Nothing left in the device-side meta store either - on a hub that can
  // hold decoration it should never have been written there at all, and an
  // entry that survived would be migrated forward on every launch.
  expect(await page.evaluate(() => localStorage.getItem('attackfm-playlist-meta') ?? '')).not.toContain(
    'Songs for a long drive',
  );
});

test('the folder it is filed under, and the cover chosen for it, survive a relaunch', async ({ page, hub }) => {
  const name = `${MINE}Filed Away`;
  const tracks = await hub.tracks();
  await hub.post('/api/playlists', { name, tracks: [tracks[0]!.id] });

  await openLibrary(page);
  await openPlaylist(page, name);

  // A folder is only a label on the lists in it, so naming one and filing this
  // list into it are the same act - there is no empty folder to make first.
  await page.getByRole('button', { name: 'Playlist actions' }).first().click();
  await page.getByRole('menuitem', { name: 'New folder…' }).click();
  const folder = page.getByRole('dialog', { name: 'New folder' });
  await folder.getByRole('textbox', { name: 'Folder name' }).fill('Road trips');
  await folder.getByRole('button', { name: 'Move here' }).click();

  /*
   * A cover, chosen the way a person chooses one: the menu item opens a file
   * chooser, and what comes back goes to the hub rather than into this device.
   * The image is a real (very small) JPEG - the hub stores what it is given and
   * hands back a url, and a byte string that is not an image would be testing
   * the error path by accident.
   */
  const picking = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Playlist actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Choose cover…' }).click();
  await (await picking).setFiles({ name: 'cover.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(TINY_JPEG, 'base64') });
  // The hub answers with the cover's own filename; the display-ready url is
  // the client's arithmetic over it, so this is the half that is stored.
  await expect.poll(async () => (await listOnHub(hub, name)).cover ?? '').not.toBe('');

  /*
   * Both are DECORATION, and decoration is the part of a playlist that used to
   * live on the device that wrote it. On a hub that can hold it, it belongs to
   * the list - so it has to be there after a relaunch, and it has to be there
   * on the shelf as well as on the page.
   */
  await page.reload();
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'Road trips 1' })).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(name) }).first()).toBeVisible();
  // The tile wears the chosen image rather than the song mosaic it falls back
  // to - which is the half of "the cover survived" that a hub field cannot say.
  await expect(page.locator('img.tileChosenCover').first()).toBeVisible();

  // And back out of it: a list can leave a folder, which is what makes filing
  // a decision rather than a one-way door.
  await page.getByRole('button', { name: new RegExp(name) }).first().click();
  await page.getByRole('button', { name: 'Playlist actions' }).first().click();
  await page.getByRole('menuitem', { name: 'Take out of Road trips' }).click();
  await expect.poll(async () => (await listOnHub(hub, name)).folder ?? '').toBe('');
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByRole('heading', { name: 'Road trips 1' })).toHaveCount(0);
});

test('a list the server generated is not one of the lists you made', async ({ page, hub }) => {
  const mine = `${MINE}Mine`;
  const chart = `${MINE}Top Fixture 50`;
  const tracks = await hub.tracks();
  await hub.post('/api/playlists', { name: mine, tracks: [tracks[0]!.id] });
  const made = await hub.post<{ id: number }>('/api/playlists', { name: chart, tracks: [tracks[1]!.id] });
  // The folder IS the test: `Charts` and `New music` are the two the server
  // fills on its own clock, and every list surface gates on that one predicate.
  await hub.put(`/api/playlists/${made.id}`, { folder: 'Charts' });

  await openLibrary(page);
  // The Library holds what you saved or made, so a chart list is not on this
  // shelf at all - it belongs to Discover.
  await expect(page.getByRole('button', { name: new RegExp(mine) }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: new RegExp(chart) })).toHaveCount(0);

  /*
   * And it is not somewhere to file a song either.
   *
   * The picker listed the server's chart lists fifteen deep above the lists a
   * person actually keeps, which is the regression this asserts: filing a song
   * offers `mine` and does not offer `chart`.
   */
  await openRecent(page);
  await rowMenuItem(page, 'Kindling', artistOf('Kindling'), 'Add to playlist…');
  const sheet = page.getByRole('dialog', { name: 'Add to playlist' });
  await expect(sheet.getByRole('button', { name: new RegExp(mine) })).toBeVisible();
  await expect(sheet.getByRole('button', { name: new RegExp(chart) })).toHaveCount(0);
});

test("a friend's list arrives with a New badge and loses it once opened", async ({ page, browser, hub, world }) => {
  const name = `${MINE}Shared`;
  const tracks = await hub.tracks();
  const made = await hub.post<{ id: number }>('/api/playlists', {
    name,
    tracks: [tracks.find((t) => t.title === 'Kindling')!.id],
  });

  // Seated through the sheet, the way a person does it: the friend picker is
  // where the consent lives (a share is only ever to somebody on this hub).
  await openLibrary(page);
  await openPlaylist(page, name);
  await page.getByRole('button', { name: 'Playlist actions' }).first().click();
  await page.getByRole('menuitem', { name: /Share with friends/ }).click();
  const share = page.getByRole('dialog', { name: 'Share playlist' });
  await share.getByRole('button', { name: /Add people/ }).click();
  const people = page.getByRole('dialog', { name: 'Add people' });
  await people.getByRole('checkbox', { name: /^kim/ }).check();
  // The button COUNTS what is chosen ("Add 1 to the playlist"), so it cannot
  // be matched by the empty-handed wording it wears while it is still dead.
  await people.getByRole('button', { name: /to the playlist$/ }).click();
  // Two on the seat list now. Counted rather than matched by name: the
  // picker's own chips are list items too and stay mounted behind the sheet,
  // so "a list item saying kim" is two things.
  await expect(share.getByRole('heading', { name: 'People 2' })).toBeVisible();

  await expect
    .poll(async () => (await hub.get<{ members: Array<{ username: string }> }>(`/api/playlists/${made.id}/members`)).members.map((m) => m.username))
    .toContain('kim');

  /*
   * Kim's side. The list arrives on its own shelf - not among the ones she
   * made - wearing New until this device has looked at it, and the ledger
   * behind that badge is per-device, so it has to survive a reload.
   */
  const kim = await secondPerson(browser, world, 'kim');
  try {
    await expect(kim.page.getByRole('heading', { name: /Shared with you/ })).toBeVisible();
    const fresh = kim.page.getByRole('button', { name: `${name}, new` });
    await expect(fresh).toBeVisible();

    await fresh.click();
    await expect(kim.page.getByRole('heading', { name })).toBeVisible();
    await expect(kim.page.getByText('Shared by matt · you can edit')).toBeVisible();

    await kim.page.getByRole('button', { name: 'Library' }).click();
    await expect(kim.page.getByRole('button', { name: `${name}, new` })).toHaveCount(0);
    await expect(kim.page.getByRole('button', { name: new RegExp(name) }).first()).toBeVisible();

    // Opening is what accepts the invitation, and it stays accepted.
    await kim.page.reload();
    await expect(kim.page.getByRole('heading', { name: /Shared with you/ })).toBeVisible();
    await expect(kim.page.getByRole('button', { name: `${name}, new` })).toHaveCount(0);
  } finally {
    await kim.context.close();
  }
});

test("@slow a friend's addition arrives on the owner's open page", async ({ page, browser, hub, world }) => {
  const name = `${MINE}Together`;
  const tracks = await hub.tracks();
  const made = await hub.post<{ id: number }>('/api/playlists', {
    name,
    tracks: [tracks.find((t) => t.title === 'Kindling')!.id],
  });
  await hub.post(`/api/playlists/${made.id}/members`, { userId: world.userIds.kim, role: 'editor' });

  await openLibrary(page);
  await openPlaylist(page, name);
  expect(await listedTitles(page)).toEqual(['Kindling']);

  const kim = await secondPerson(browser, world, 'kim');
  try {
    // Kim files a song from her own library into the list matt is looking at.
    await kim.page.getByRole('button', { name: new RegExp(name) }).first().click();
    await expect(kim.page.getByRole('heading', { name })).toBeVisible();
    await kim.page.getByRole('button', { name: 'Library' }).click();
    await openRecent(kim.page);
    await fileSong(kim.page, 'Longhand', name);

    /*
     * And it turns up on matt's page WITHOUT him doing anything.
     *
     * Slow on purpose: the playlist store re-reads the hub on the same
     * half-minute heartbeat the library runs, so this is a POLL_IDLE window,
     * not an instant push. Asserting it any faster would mean asserting a
     * mechanism the app does not have.
     */
    await expect.poll(() => listedTitles(page), { timeout: 60_000 }).toEqual(['Kindling', 'Longhand']);
  } finally {
    await kim.context.close();
  }
});

test('@slow deleting the open list from another window walks this one out', async ({ page, browser, hub, world }) => {
  const name = `${MINE}Doomed`;
  const tracks = await hub.tracks();
  await hub.post('/api/playlists', { name, tracks: [tracks[0]!.id] });

  await openLibrary(page);
  await openPlaylist(page, name);

  /*
   * A second window of the same account deletes it out from under the first.
   *
   * The page it was open on has to LEAVE - `onGone` - rather than render a
   * playlist that is not there any more, and it has to do it without throwing:
   * the hooks in this page were once ordered so that the disappearing list
   * unmounted half of them mid-render. A pageerror here is the failure, not a
   * missing heading.
   */
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const other = await secondPerson(browser, world, 'matt');
  try {
    await other.page.getByRole('button', { name: new RegExp(name) }).first().click();
    await expect(other.page.getByRole('heading', { name })).toBeVisible();
    await other.page.getByRole('button', { name: 'Playlist actions' }).first().click();
    await other.page.getByRole('menuitem', { name: 'Delete playlist' }).click();
    await other.page.getByRole('dialog', { name: `Delete “${name}”?` }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(other.page.getByRole('heading', { name })).toHaveCount(0);

    // The first page finds out on its own heartbeat - the same thirty seconds
    // as the addition above.
    await expect(page.getByRole('heading', { name })).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByRole('button', { name: /^Recent/ }).first()).toBeVisible();
    expect(crashes).toEqual([]);
  } finally {
    await other.context.close();
  }
});
