/**
 * The library as a person reads it, and the search that finds a way into it.
 *
 * The library is the page every other page is one tap from, so what is asserted
 * here is not "the shelves rendered" but the handful of contracts that have
 * actually broken in this repo's history: the row your finger went down on is
 * the row that plays, the queue is the list as SHOWN rather than as stored, a
 * relaunch paints from the cached index instead of a blank page, "like these
 * nine" never un-likes the two that were already liked, and a typo is rescued
 * out loud rather than silently.
 *
 * Fixture: `hub-seeded` - twelve tagged tracks over four records, two of them
 * by one artist, plus the untagged book behind the Books tab. Titles share no
 * words across records, which is what makes every search assertion below
 * unambiguous.
 *
 * ONE HUB SERVES EVERY SUITE. The one thing this file writes - a heart - is
 * swept in `afterEach` rather than left for the next file to count.
 */
import { expect, test } from './fixtures/hub.ts';
import {
  clearFavourites,
  newestFirst,
  playingTitle,
  rowMenuItem,
  rowMenuMore,
  noConnect,
  songCell,
  songRow,
} from './fixtures/playlists.ts';
import type { Page } from '@playwright/test';

/**
 * Who made what, for the twelve.
 *
 * A song row is named by title AND artist (see `songCell`), because a title
 * alone is ambiguous even in a fixture this small - "Longhand" is a song, a
 * record, and the album cell of another song. Written out rather than derived
 * from the manifest so a test reads as the sentence it is asserting.
 */
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

function artistOf(title: string): string {
  const artist = ARTIST_OF[title];
  if (!artist) throw new Error(`e2e: no fixture artist for "${title}"`);
  return artist;
}

/** The library, painted, signed in as the fixture's admin, and alone on it. */
async function openLibrary(page: Page): Promise<void> {
  // See `noConnect`: without it a page is a Connect device, and the seat the
  // previous context left behind makes this one a remote of a ghost.
  await noConnect(page);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
}

/**
 * "Recently added" as a full page of song rows.
 *
 * The Library tab itself only ever draws shelves - the whole-table face lives
 * on the collection pages - and Recent is the one that holds every fixture
 * track (its cap is fifty). It is a `flow` table, which is the mode the app
 * uses everywhere a page scrolls rather than a shelf.
 */
async function openRecent(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Recent/ }).first().click();
  await expect(page.getByRole('grid', { name: 'Songs' })).toBeVisible();
}

/**
 * The search overlay, open, with the catalogue answering deterministically.
 *
 * `/api/search` is the hub's door onto Spotify and Deezer. Left alone it is a
 * real request to the real internet from a test about a local library: slow,
 * offline-fragile, and - because the page holds its empty state back while the
 * catalogue is still in flight - the difference between "nothing found"
 * appearing and not. Stubbed empty, the local half is all that is left, which
 * is the half these tests are about.
 */
async function openSearch(page: Page, hubUrl: string) {
  await page.route(`${hubUrl}/api/search?**`, (route) => route.fulfill({ json: { results: [] } }));
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Search' }).click();
  const overlay = page.getByRole('dialog', { name: 'Search' });
  await expect(overlay).toBeVisible();
  return { overlay, field: page.getByRole('combobox', { name: 'Search' }) };
}

/** The song titles the table is showing, top to bottom. */
async function shownTitles(page: Page): Promise<string[]> {
  return page.locator('.songTitle__name').allInnerTexts();
}

test.afterEach(async ({ hub }) => {
  await clearFavourites(hub);
});

test("the library opens on this hub's own songs, newest record first", async ({ page, hub, world }) => {
  await openLibrary(page);

  // The count is the app's own arithmetic over the rows it synced, and the
  // book's twelve chapters are deliberately not in it.
  await expect(page.getByText(`${world.library.tracks.length} songs`)).toBeVisible();

  /*
   * "Recently added" is an ORDER, not a set.
   *
   * Read back off the hub rather than off the fixture array: `added_at` is the
   * hub's own insert clock (global-setup scans between records to spread the
   * stamps), so the fixture's declaration order is only what was WRITTEN. A
   * later suite that adds a row would make a hard-coded expectation wrong for
   * a reason that has nothing to do with the shelf.
   */
  const newest = await newestFirst(hub);
  const shelf = page.locator('.homeShelf', { has: page.getByRole('heading', { name: 'Recently added' }) });
  // Each card announces itself as "<album> <artist>", so the first few name
  // the records in the order the hub took them in.
  const cards = shelf.getByRole('button');
  for (const [i, track] of newest.slice(0, 3).entries()) {
    await expect(cards.nth(i)).toHaveAccessibleName(`${track.album} ${track.artist}`);
  }

  // The book is behind Books, and Music comes back unchanged - that split is
  // the whole reason the `Audiobooks/` folder is a contract. Clicked by its
  // LABEL: the label sits over the radio and takes the pointer.
  const sections = page.getByRole('radiogroup', { name: 'Library section' });
  await sections.getByText('Books', { exact: true }).click();
  await expect(page.getByText(world.library.book.title).first()).toBeVisible();
  await sections.getByText('Music', { exact: true }).click();
  await expect(page.getByText(`${world.library.tracks.length} songs`)).toBeVisible();
});

test('a relaunch paints the cached index before the hub answers', async ({ page, world }) => {
  await openLibrary(page);
  const songs = `${world.library.tracks.length} songs`;
  await expect(page.getByText(songs)).toBeVisible();

  /*
   * Hold the delta sync open and reload.
   *
   * The library the app draws on a relaunch comes out of IndexedDB
   * (`hydrateCachedIndex`), and the whole point of that cache is that it beats
   * the network. So the honest test is not "the rows appear" - they would
   * eventually, either way - but "the rows appear while the request that would
   * have fetched them is still in flight". If the cache regresses, this page
   * is skeletons until the route is released.
   */
  let release = (): void => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let asked = 0;
  await page.route(/\/api\/library\?since=/, async (route) => {
    asked += 1;
    await held;
    // The page may already be on its way out by the time this is let go; a
    // route that can no longer be continued is not a failure of the thing
    // being tested.
    await route.continue().catch(() => {});
  });

  try {
    await page.reload();
    await expect(page.getByText(songs)).toBeVisible();
    // Not "the app skipped the sync" - it must still ask - but "it painted
    // without waiting for the answer".
    expect(asked).toBeGreaterThan(0);
  } finally {
    release();
  }
});

test('a sorted table plays the row pointed at, and queues the list as shown', async ({ page }) => {
  await openLibrary(page);
  await openRecent(page);

  // Alphabetical by title is the table's opening order; one click on the
  // header turns it round, which is the cheapest way to get a displayed order
  // that is not the stored one.
  const before = await shownTitles(page);
  await page.getByRole('columnheader', { name: 'Title' }).click();
  await expect.poll(async () => (await shownTitles(page))[0]).toBe(before[before.length - 1]);
  const shown = await shownTitles(page);
  expect(shown).toEqual([...before].reverse());

  /*
   * The row the finger went down on is the row that opens.
   *
   * A tap used to open whatever had slid into that spot by the time the click
   * was delivered - the song BELOW the one aimed at - which is what the
   * pointerdown anchor in SongTable exists to stop. Asserted through
   * `aria-current`, the attribute the playing row publishes and the little
   * bars beside the name lean on.
   */
  await songRow(page, shown[0]!, artistOf(shown[0]!)).click();
  await expect.poll(() => playingTitle(page)).toBe(shown[0]);

  // Held there before anything is asked of the queue. A fixture track is
  // twelve to twenty-two seconds long, and a deck left running walks off the
  // end of one mid-assertion - which reads as the wrong song rather than as
  // the clock it is.
  await page.getByRole('button', { name: 'Pause' }).first().click();

  /*
   * And the queue is the list AS SHOWN.
   *
   * The table hands the player `displayed`, not `tracks`; when the two
   * disagreed - a column whose comparator existed in only one of them - the
   * grid re-sorted and the queue did not, silently. Skipping once is what
   * separates them: under the stored order this lands on a different song.
   */
  await page.getByRole('button', { name: 'Next', exact: true }).first().click();
  await expect.poll(() => playingTitle(page)).toBe(shown[1]);
});

test('search finds a song, a record and an artist, each as its own Top result', async ({ page, world }) => {
  await openLibrary(page);
  const { field } = await openSearch(page, world.hubUrl);

  // A song title nothing else answers to.
  await field.fill('Kindling');
  await expect(page.getByRole('option', { name: /^Kindling Song/ })).toBeVisible();

  /*
   * A record beats its own tracks.
   *
   * Somebody typing a record's name wants the record, so the album takes the
   * hero and the songs go beside it - the rule the Top card exists to apply.
   */
  await field.fill('Blue Hour');
  await expect(page.getByRole('option', { name: /^Blue Hour Album · Nova Static/ })).toBeVisible();

  // And an artist beats both. Nova Static has two records, so the count is a
  // real sum rather than one album read twice.
  await field.fill('Nova Static');
  await expect(page.getByRole('option', { name: /^Nova Static Artist · 7 songs/ })).toBeVisible();
  // Their whole discography is here, not just the record the words hit.
  const albums = page.getByRole('group', { name: 'Albums' });
  await expect(albums.getByRole('option', { name: /^Blue Hour Album/ })).toBeVisible();
  await expect(albums.getByRole('option', { name: /^Ember Days Album/ })).toBeVisible();

  // The chips narrow rather than re-query: picking Albums leaves the two
  // records and takes the seven songs away.
  await page.getByRole('tab', { name: 'Albums' }).click();
  await expect(page.getByRole('option', { name: /^Blue Hour Album/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Song ·/ })).toHaveCount(0);
});

test('a field operator narrows, and an operator that matches nothing is not rescued', async ({ page, world }) => {
  await openLibrary(page);
  const { field } = await openSearch(page, world.hubUrl);

  /*
   * `artist:"Nova Static" ember` - the operator picks the artist, the free
   * text picks which of their records. Both halves have to bite: the operator
   * alone gives seven songs, and the free text alone would also match the song
   * called "Ember Days" on its own terms.
   */
  await field.fill('artist:"Nova Static" ember');
  await expect(page.getByRole('option', { name: /^Ember Days Album · Nova Static/ })).toBeVisible();
  const rows = page.getByRole('option', { name: /Song ·/ });
  await expect(rows).toHaveCount(3);
  for (const text of await rows.allInnerTexts()) expect(text).toContain('Nova Static');

  // A genre is a field too, and Folk is one record's alone.
  await field.fill('genre:"Folk"');
  await expect(page.getByRole('option', { name: /^Margin Sketch Song/ })).toBeVisible();
  await expect(page.getByRole('option', { name: /Nova Static/ })).toHaveCount(0);

  /*
   * An operator that matched nothing means the library does not hold it, and
   * the typo rescue cannot fix that - only free text can be mistyped into
   * nothing. "ember" is a real word here and "Marla Vane" is a real artist
   * here; the PAIR is not, and no near-miss may be offered for it.
   */
  await field.fill('artist:"Marla Vane" ember');
  await expect(page.getByText(/this is the closest your library has/)).toHaveCount(0);
  await expect(page.getByRole('option')).toHaveCount(0);
});

test('a misspelling is rescued out loud, and a query nothing answers is not', async ({ page, world }) => {
  await openLibrary(page);
  const { field } = await openSearch(page, world.hubUrl);

  // One letter wrong. The rescue pass runs, finds the song, and the page says
  // so - the banner is the app admitting it answered a different question.
  await field.fill('Kindliing');
  await expect(
    page.getByText('Nothing matches “Kindliing” exactly — this is the closest your library has.'),
  ).toBeVisible();
  await expect(page.getByRole('option', { name: /^Kindling Song/ })).toBeVisible();

  /*
   * And when the rescue ALSO finds nothing, the banner must not appear.
   *
   * It used to mean "the second pass ran" rather than "the second pass found
   * something", so a query with no answer printed 'this is the closest your
   * library has' over an empty space - telling somebody their library holds a
   * near-miss it does not hold.
   */
  await field.fill('zzzqqqxyzzy');
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(page.getByText(/this is the closest your library has/)).toHaveCount(0);

  /*
   * What an empty result says.
   *
   * Only in the Discover scope, and that is not this test being fussy - see
   * the report. The page holds its empty state back while the catalogue is
   * still in flight (`catalog !== null`), and the catalogue is only ASKED once
   * Discover is on, so in "Yours" the sentence below is unreachable and a
   * fruitless search shows nothing at all. The stub in `openSearch` is what
   * makes the ask answer at once.
   */
  await page.getByRole('radiogroup', { name: 'Where to search' }).getByText('Discover', { exact: true }).click();
  await expect(page.getByText('Nothing found for “zzzqqqxyzzy”.')).toBeVisible();
});

test('opening a search hit plays the song, and opening an artist opens their page', async ({ page, world }) => {
  await openLibrary(page);
  const { field } = await openSearch(page, world.hubUrl);

  await field.fill('Paper Lantern');

  await page.getByRole('option', { name: /^Paper Lantern Song/ }).click();
  // Playing, before anything else is asked of it: the strip's play control
  // turns into Pause the moment the deck takes the song, and the overlay is
  // over the strip rather than instead of it - so this is readable here, and
  // clickable in a moment.
  const pause = page.getByRole('button', { name: 'Pause' }).first();
  await expect(pause).toBeVisible();

  /*
   * The overlay deliberately STAYS - playing a song is not leaving search - so
   * "which song started" is asked of the lists instead: close the overlay,
   * open a table, and the row wearing `aria-current` is the answer. That also
   * pins the highlight following the player into a list it was not started
   * from, which is a feature of its own.
   */
  await page.getByRole('button', { name: 'Close search' }).click();
  await expect(page.getByRole('dialog', { name: 'Search' })).toBeHidden();
  // Held as soon as the strip is reachable: sixteen seconds of song is not
  // long enough to walk back to the library and still be the song playing,
  // and a deck that has walked on reads as the wrong song rather than as the
  // clock it is. (The overlay covers the strip, so this cannot happen while
  // it is up.)
  await pause.click();
  await openRecent(page);
  await expect.poll(() => playingTitle(page)).toBe('Paper Lantern');

  // An artist row is a door, not a play.
  const again = await openSearch(page, world.hubUrl);
  await again.field.fill('The Quiet Ledger');
  await page.getByRole('option', { name: /^The Quiet Ledger Artist/ }).click();
  await expect(page.getByRole('heading', { name: 'The Quiet Ledger', level: 1 })).toBeVisible();
  await expect(page.getByText('3 songs · 1 album')).toBeVisible();
  // Their record, with the songs of it this library holds.
  await expect(page.getByRole('grid', { name: 'Songs' })).toBeVisible();
  await expect(songCell(page, 'Ledger Line', 'The Quiet Ledger')).toBeVisible();
});

test('liking nine songs sets all nine and un-likes neither of the two already liked', async ({ page, hub }) => {
  await openLibrary(page);
  await openRecent(page);
  const shown = await shownTitles(page);
  const byTitle = new Map((await hub.tracks()).map((t) => [t.title as string, t.id as number]));
  const favourites = async () =>
    (await hub.get<{ tracks: number[] }>('/api/favorites')).tracks.slice().sort((a, b) => a - b);

  /*
   * Two of them are liked first, one at a time, the way a person does it.
   *
   * This is the whole point of the scenario: the bulk verb is a SET, not a
   * toggle. `toggleFavorite` over a selection that already holds liked songs
   * would take those two back OUT while adding the other seven, and the count
   * would look right while the wrong nine were liked.
   */
  const chosen = shown.slice(0, 9);
  for (const title of chosen.slice(0, 2)) {
    await rowMenuItem(page, title, artistOf(title), 'Love this song');
  }
  await expect.poll(favourites).toEqual(chosen.slice(0, 2).map((t) => byTitle.get(t)!).sort((a, b) => a - b));

  // Into selection mode from the third song's menu, which selects it, then the
  // rest by tapping their rows: nine in all, two of them already liked.
  await rowMenuMore(page, chosen[2]!, artistOf(chosen[2]!), 'Select songs…');
  const bar = page.getByRole('toolbar', { name: 'Selected songs' });
  await expect(bar).toBeVisible();
  for (const title of [...chosen.slice(0, 2), ...chosen.slice(3)]) {
    await songRow(page, title, artistOf(title)).click();
  }
  await expect(bar.getByText('9', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Add to Liked' }).click();

  await expect.poll(favourites).toEqual(chosen.map((t) => byTitle.get(t)!).sort((a, b) => a - b));

  // And the Liked page is those nine, so the shelf agrees with the hub.
  await page.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('button', { name: /^Liked/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Liked songs' })).toBeVisible();
  await expect(page.getByText('9 songs')).toBeVisible();
});

test('the song table sheds columns rather than overflowing its page', async ({ page }) => {
  await openLibrary(page);
  await openRecent(page);

  /*
   * A fixed-layout table in a narrow column is how this app once got a page
   * that scrolled sideways - and a table cannot be narrowed by hiding columns
   * with `display: none`, which is the fix that looks obvious and is not.
   * Measured at both ends: the desk, and a phone.
   */
  const overflow = async () =>
    page.evaluate(() => {
      const el = document.querySelector('.homePage');
      return el ? el.scrollWidth - el.clientWidth : -1;
    });
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  await expect(page.getByRole('columnheader', { name: 'Date added' })).toBeVisible();

  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.getByRole('grid', { name: 'Songs' })).toBeVisible();
  await expect.poll(overflow).toBeLessThanOrEqual(1);
  // Still a table of songs, just fewer columns of them.
  await expect(page.getByRole('columnheader', { name: 'Title' })).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 720 });
});
