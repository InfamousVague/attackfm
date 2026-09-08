/**
 * Audiobooks: a book the way a listener meets it.
 *
 * The fixture book is the shape the whole feature rests on - twelve MP3s under
 * `Audiobooks/Ada Sorrel/The Long Ascent/`, eight seconds each, carrying NO
 * TAGS AT ALL. That is not a shortcut in the fixture: it is a split-MP3
 * download, the commonest way an audiobook arrives, and everything the shelf
 * knows about it has to be recovered from where the files sit and what they
 * are called. `Audiobooks/` IS the contract (`scan.rs` decides a file is a
 * book by that folder name and nothing else), the author is the folder above,
 * the book is the folder itself, and each chapter's name is its filename.
 *
 * The suite exists because this feature was DELETED WHOLE on 12 August and
 * brought back on the 22nd. What survived the removal untouched - the player
 * still walking chapters, the bookmark still kept - is exactly what has no
 * test, so it is what is tested here.
 *
 * SIGNED IN AS `ana`, ON PURPOSE. The hub has no way to delete a play-state,
 * and half of what follows writes one, so a book mark left behind is
 * permanent for the run. Leaving them on `ana` keeps `matt` - the account
 * every other suite starts as - exactly as global-setup left him.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/hub.ts';

test.use({ afmUser: 'ana' });

/**
 * ONE DEVICE, ON ITS OWN.
 *
 * Every browser context mints a fresh Connect device id (`connect.ts` writes a
 * random UUID into localStorage on first boot), so every test in a run is a
 * NEW device on this account - and a device that played something stays the
 * hub's active seat long after Playwright has closed its context, because
 * nothing has told the hub it is gone and the heartbeat drop is a minute away.
 *
 * The next test then boots as a REMOTE: its strip mirrors the dead device's
 * song, and pressing play sends a command to a browser that no longer exists.
 * Measured: twenty seconds after the press, nothing had happened and nothing
 * said why. Whether that dead end is a defect is a question for the `connect`
 * suite, which owns the seat; it is not a thing this suite should be silently
 * subject to.
 *
 * So the Connect socket is answered here and told nothing. The device is alone,
 * which is how somebody listens to a book - and, as a side effect, this suite
 * registers no device and so poisons nobody else's.
 */
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/\/api\/connect/, () => {
    // Accepted, and never spoken to.
  });
});

/** A library row as the hub serves it. */
interface LibraryRow {
  id: number;
  title: string;
  kind: string;
  album: string;
  artist: string;
  albumArtist: string;
  trackNo: number | null;
  duration: number;
  chapters: unknown[];
}

/**
 * The Books half of the library.
 *
 * Clicked by its LABEL, not by the radio. The SegmentedControl paints a label
 * span over its input, so a click on the role never lands - and that is what a
 * listener's thumb hits too, which is why this is the honest gesture rather
 * than a `force: true` that would also pass on a control nobody can reach.
 */
async function openShelf(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  const sections = page.getByRole('radiogroup', { name: 'Library section' });
  await sections.getByText('Books', { exact: true }).click();
}

/**
 * The book's own card.
 *
 * Its accessible name is the VERB, and the verb is the state: "Start" for a
 * book nobody has opened, "Continue" for one with a mark against any of its
 * files. So `started` is readable from the accessibility tree without going
 * near a class name, and the standing line ("Intro · under a minute in") is
 * inside the same control.
 */
function bookCard(page: Page, verb: 'Start' | 'Continue'): Locator {
  return page.getByRole('button', { name: `${verb} The Long Ascent` });
}

/** The chapters sheet, off the card's chevron. */
async function openChapters(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Chapters of The Long Ascent' }).click();
  const sheet = page.getByRole('dialog', { name: 'The Long Ascent' });
  await expect(sheet).toBeVisible();
  return sheet;
}

/**
 * The chapter names in the sheet, in the order the sheet has them.
 *
 * Picked out of the sheet's buttons by shape rather than by position, because
 * the sheet holds two other controls - its Close, and a Catch-me-up that
 * appears only once the book has been started - and because the row you are
 * STANDING on swaps its seat number for a play mark, so a row's full text is
 * not stable across a book that has been read and one that has not.
 */
async function chapterNames(sheet: Locator): Promise<string[]> {
  const texts = await sheet.getByRole('button').allInnerTexts();
  return texts
    .map((t) => /(?:^|\s)(Chapter \d+)$/.exec(t.replace(/\s+/g, ' ').trim())?.[1])
    .filter((t): t is string => t !== undefined);
}

/**
 * One chapter row, by the chapter's own name.
 *
 * Anchored at the end so "Chapter 1" cannot also answer for "Chapter 11", and
 * open at the front so it matches the row whether it is wearing its seat
 * number ("4 Chapter 4") or the play mark that replaces it on the chapter the
 * reading is standing on.
 */
function chapterRow(sheet: Locator, name: string): Locator {
  return sheet.getByRole('button', { name: new RegExp(`(^|\\s)${name}$`) });
}

test('the Audiobooks folder is the contract: twelve untagged files are one book, not twelve songs', async ({
  page,
  hub,
  world,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const rows = await hub.get<{ tracks: LibraryRow[] }>('/api/library?since=0&limit=500');
  const chapters = rows.tracks.filter((t) => t.kind === 'book');
  expect(chapters).toHaveLength(12);

  /*
   * EVERYTHING ABOUT THIS BOOK CAME FROM THE PATH.
   *
   * The files carry no tags whatsoever - no title, no artist, no album, not
   * even ffmpeg's own encoder string - so an album is only "The Long Ascent"
   * because that is the folder, an artist only "Ada Sorrel" because that is
   * the folder above, and a title only "Chapter 7" because that is the file.
   * A scanner that stopped reading the path would leave twelve nameless rows
   * and one nameless book, and every assertion below it would still pass.
   */
  for (const chapter of chapters) {
    expect(chapter.album).toBe('The Long Ascent');
    expect(chapter.artist).toBe('Ada Sorrel');
    expect(chapter.albumArtist).toBe('Ada Sorrel');
    expect(chapter.trackNo).toBeNull();
    // Not an m4b: no markers inside the file, so the FILES are the chapters.
    expect(chapter.chapters).toEqual([]);
  }
  expect(new Set(chapters.map((c) => c.title))).toEqual(
    new Set(world.library.book.chapters),
  );

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  /*
   * AND THE SONGS DO NOT KNOW ABOUT IT.
   *
   * A twelve-hour reading loose among the songs is the wrong thing in a mix,
   * in shuffle and in search, so the library holds books apart from `tracks`.
   * The hero's own count is the cheapest possible check that it still does:
   * with the split broken this reads 24.
   */
  await expect(page.getByText(`${world.library.tracks.length} songs`)).toBeVisible();

  await openShelf(page);
  await expect(page.getByText('The Long Ascent').first()).toBeVisible();
  await expect(page.getByText('Ada Sorrel').first()).toBeVisible();

  expect(crashes).toEqual([]);
});

test('the chapters are in reading order, which a plain string sort gets wrong', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  await page.goto('/');
  await openShelf(page);
  const sheet = await openChapters(page);

  /*
   * 1, 2, 3 ... 10, 11, 12 - and this is the whole test.
   *
   * These files carry no track numbers, so `chapterOrder` falls through to
   * comparing their NAMES, and a plain `localeCompare` puts "Chapter 10"
   * second and "Chapter 2" fifth. For a record that is cosmetic. For a book it
   * is the book in the wrong order, and the reader hears chapter ten after
   * chapter one. `numeric: true` is the one thing standing between those two
   * outcomes, and nothing on the shelf says which one you have got.
   */
  expect(await chapterNames(sheet)).toEqual([
    'Chapter 1',
    'Chapter 2',
    'Chapter 3',
    'Chapter 4',
    'Chapter 5',
    'Chapter 6',
    'Chapter 7',
    'Chapter 8',
    'Chapter 9',
    'Chapter 10',
    'Chapter 11',
    'Chapter 12',
  ]);

  expect(crashes).toEqual([]);
});

test('opening a chapter plays THAT chapter, with the rest of the book behind it', async ({
  page,
  hub,
  world,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const rows = await hub.get<{ tracks: LibraryRow[] }>('/api/library?since=0&limit=500');
  const idOf = (title: string) =>
    rows.tracks.find((t) => t.kind === 'book' && t.title === title)!.id;

  // Which FILE the deck actually asked the hub for. A label can be right while
  // the wrong bytes play; this cannot.
  const streamed: number[] = [];
  page.on('request', (request) => {
    const hit = new RegExp(`^${world.hubUrl}/api/stream/(\\d+)`).exec(request.url());
    if (hit) streamed.push(Number(hit[1]));
  });

  await page.goto('/');
  await openShelf(page);
  const sheet = await openChapters(page);
  await chapterRow(sheet, 'Chapter 3').click();

  const player = page.getByRole('dialog', { name: 'Now playing' });
  await expect(player).toBeVisible();
  await expect(player.getByRole('button', { name: 'Pause' })).toBeVisible();

  /*
   * THE BOOK'S OWN NUMBER FOR IT, which is not its seat.
   *
   * With no transcript to say what the narrator announced, the tags are all
   * there is - and a bought audiobook opens with the publisher's card, which
   * whoever ripped it numbered as chapter one. So `chapterNumbers` treats the
   * opening section as front matter and counts from after it: the third FILE
   * is the book's chapter 2. That is the whole point of the function, and the
   * caption is where a listener sees it.
   */
  await expect(player.getByText('Chapter 2 of 12')).toBeVisible();

  // And the reading list agrees about where we are standing.
  const list = player.getByRole('list', { name: 'Chapters' });
  await expect(list.getByRole('listitem')).toHaveCount(12);
  await expect(list.getByRole('listitem').nth(2)).toHaveAttribute('data-here', 'true');

  // The bytes came from the third file, not from whatever a sort left first.
  await expect.poll(() => streamed).toContain(idOf('Chapter 3'));

  expect(crashes).toEqual([]);
});

test('where the book stands is read from the hub, and the opening section is Intro rather than a second Chapter 1', async ({
  page,
  hub,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const rows = await hub.get<{ tracks: LibraryRow[] }>('/api/library?since=0&limit=500');
  const idOf = (title: string) =>
    rows.tracks.find((t) => t.kind === 'book' && t.title === title)!.id;

  // The mark is the hub's, not this device's: a place kept on the sofa is
  // meant to be there on the bus. Written through the same endpoint the
  // player writes it through, so this is the state another device would leave.
  await hub.post('/api/play-state', { trackId: idOf('Chapter 1'), positionMs: 4_000 });

  await page.goto('/');
  await openShelf(page);

  /*
   * THE OPENING SECTION HAS NO NUMBER, so it is not "Chapter 1".
   *
   * The tags cannot tell a publisher's card from a real first chapter - both
   * are called "Chapter 1" - so the app stops trying to and takes the shape
   * these books actually have: the opening section is the intro and the
   * counting starts after it. Without that the whole book reads one ahead of
   * itself, for thirteen hours, with every surface agreeing with every other
   * because they all count from the same wrong place.
   */
  const started = bookCard(page, 'Continue');
  await expect(started).toBeVisible();
  await expect(started).toContainText('Intro');
  // The hero's one verb, pointing at the book most recently touched.
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();

  // Move the mark on by one file and the numbering starts.
  await hub.post('/api/play-state', { trackId: idOf('Chapter 2'), positionMs: 4_000 });
  await page.reload();
  await openShelf(page);
  await expect(bookCard(page, 'Continue')).toContainText('Ch 1 of 12');

  expect(crashes).toEqual([]);
});

test('a chapter that runs out hands the book to the NEXT one', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  await page.goto('/');
  await openShelf(page);
  const sheet = await openChapters(page);
  await chapterRow(sheet, 'Chapter 1').click();

  const player = page.getByRole('dialog', { name: 'Now playing' });
  await expect(player).toBeVisible();

  /*
   * A SECTIONED BOOK'S CHAPTER BREAK IS ITS FILE'S END.
   *
   * There are no markers inside these files, so `chapterBreakAfter` has
   * nothing to arm and correctly returns null - the ended handler is what
   * carries the reading over, and the queue it carries into is the book in
   * `chapterOrder`. The failure this catches is the one the ordering exists to
   * prevent: chapter one running out and chapter TEN starting, because the
   * queue was sorted as strings.
   *
   * The caption is the tell and it cannot be faked by the chapter list beside
   * it: the second file is the book's chapter 1, so only its caption reads
   * "Chapter 1 of 12" - the first file, being front matter, has no number at
   * all and its caption is its bare name.
   */
  await expect(player.getByText('Chapter 1 of 12')).toBeVisible({ timeout: 30_000 });
  await expect(
    player.getByRole('list', { name: 'Chapters' }).getByRole('listitem').nth(1),
  ).toHaveAttribute('data-here', 'true');

  expect(crashes).toEqual([]);
});

test('where the reading got to is on the hub, and the shelf offers it back on the next visit', async ({
  page,
  hub,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const rows = await hub.get<{ tracks: LibraryRow[] }>('/api/library?since=0&limit=500');
  const chapter = rows.tracks.find((t) => t.kind === 'book' && t.title === 'Chapter 6')!;
  const markFor = async (trackId: number): Promise<number | undefined> => {
    const states = await hub.get<{ states: Array<{ trackId: number; positionMs: number }> }>(
      '/api/play-state?kind=book&limit=200',
    );
    return states.states.find((s) => s.trackId === trackId)?.positionMs;
  };

  /*
   * A chapter nothing else in this file touches, and PROVED untouched.
   *
   * The hub has no way to delete a play-state, so marks written earlier in the
   * run are still there - and an assertion that merely finds one would pass on
   * somebody else's. If a later edit makes another scenario play chapter six,
   * this line fails loudly instead of quietly turning the rest into a no-op.
   */
  expect(await markFor(chapter.id)).toBeUndefined();

  await page.goto('/');
  await openShelf(page);
  const sheet = await openChapters(page);
  await chapterRow(sheet, 'Chapter 6').click();
  const player = page.getByRole('dialog', { name: 'Now playing' });
  await expect(player).toBeVisible();

  /*
   * The mark is written every twenty seconds AND once more the moment the
   * section ends - which for an eight-second chapter is the only one that
   * happens. It is kept per PATH rather than read off the live position ref,
   * because on a track change React runs that cleanup AFTER the next track has
   * rendered: sending the ref would stamp the chapter just left with the
   * opening seconds of the one now playing, and moving between two books wiped
   * both places, which is exactly how it was reported.
   *
   * Nothing under five seconds is ever recorded, so a position past that is
   * also proof the reading was really measured rather than a freshly-loaded
   * track writing a zero over a good bookmark.
   */
  await expect.poll(() => markFor(chapter.id), { timeout: 30_000 }).toBeGreaterThan(5_000);

  // And a new visit - a fresh boot, reading the hub's ledger rather than
  // anything this page still had in hand - is offered the place back. The card
  // stops counting chapters and starts saying where you are.
  await page.reload();
  await openShelf(page);
  const card = bookCard(page, 'Continue');
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('12 chapters');
  await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();

  expect(crashes).toEqual([]);
});

test('the same place bookmarked twice is a bookmark lifted', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const marks = () =>
    page.evaluate(() => JSON.parse(localStorage.getItem('attackfm-book-bookmarks') ?? '[]') as unknown[]);

  await page.goto('/');
  await openShelf(page);
  const sheet = await openChapters(page);
  await chapterRow(sheet, 'Chapter 4').click();

  const player = page.getByRole('dialog', { name: 'Now playing' });
  // Paused first, so the needle is standing still. The button reads the LIVE
  // position, and a book that keeps playing under the two taps would be
  // bookmarking two different places - which is the one case where dropping
  // twice is not meant to lift.
  await player.getByRole('button', { name: 'Pause' }).click();

  /*
   * A bookmark is not the resume mark and the difference is the whole point:
   * the mark is written FOR you and there is one per section, a bookmark is
   * dropped BY you and there can be as many as you like. The seat in the
   * sheet's header is a book's, not a song's - filing chapter nineteen of a
   * thirteen-hour reading next to a song is not a thing anybody does - and the
   * one button both drops and lifts, its label saying which way the tap goes.
   */
  const drop = player.getByRole('button', { name: 'Bookmark this place' });
  await expect(drop).toBeVisible();
  await expect(drop).toHaveAttribute('aria-pressed', 'false');
  await drop.click();

  const lift = player.getByRole('button', { name: 'Remove the bookmark here' });
  await expect(lift).toBeVisible();
  await expect(lift).toHaveAttribute('aria-pressed', 'true');
  expect(await marks()).toHaveLength(1);

  // The second tap at the same spot is a mis-tap, not a second place - fifteen
  // seconds is about a sentence of narration - so it lifts the one just left.
  await lift.click();
  await expect(player.getByRole('button', { name: 'Bookmark this place' })).toBeVisible();
  expect(await marks()).toEqual([]);

  expect(crashes).toEqual([]);
});

test('a book is ONE row in search, however many files it is made of', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Search' }).click();
  // The kit's SearchField is an `input[type=search]` wearing `role="combobox"`
  // - it owns the results listbox below it - so it is a combobox to a screen
  // reader and to this, never a searchbox.
  await page.getByRole('combobox', { name: 'Search' }).fill('Long Ascent');

  /*
   * Books are held OUT of `tracks`, so the app's own search engine - which
   * ranks songs - cannot see them at all, and a shelf goes through
   * `filterBooks` instead. Getting that wrong in the obvious direction (put
   * the books back among the songs) does not look broken: it looks like twelve
   * results for one book, one per file, with the book itself nowhere.
   */
  const books = page.getByRole('group', { name: 'Books' });
  await expect(books).toBeVisible();
  // A result is an `option` in the results listbox, not a button.
  await expect(books.getByRole('option')).toHaveCount(1);
  await expect(books.getByRole('option')).toContainText('The Long Ascent');
  await expect(books.getByRole('option')).toContainText('12 chapters');
  await expect(page.getByRole('group', { name: 'Songs' })).toHaveCount(0);

  /*
   * And a chapter's own name finds the book, once.
   *
   * Chapter names are in the haystack because they are often the only place a
   * subtitle or a part name is written down - "Part Two: The Iron Tangle"
   * lives in the chapters, not in the album tag - and somebody hunting for
   * that half-remembered name has nowhere else to look. What comes back is
   * still the BOOK.
   */
  await page.getByRole('combobox', { name: 'Search' }).fill('Chapter 11');
  await expect(books).toBeVisible();
  await expect(books.getByRole('option')).toHaveCount(1);
  await expect(books.getByRole('option')).toContainText('The Long Ascent');

  expect(crashes).toEqual([]);
});

test('@slow a book left playing walks the whole way through its chapters, in order', async ({
  page,
  hub,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const rows = await hub.get<{ tracks: LibraryRow[] }>('/api/library?since=0&limit=500');
  const idOf = (title: string) =>
    rows.tracks.find((t) => t.kind === 'book' && t.title === title)!.id;

  const streamed: number[] = [];
  page.on('request', (request) => {
    const hit = /\/api\/stream\/(\d+)/.exec(request.url());
    if (hit) streamed.push(Number(hit[1]));
  });

  await page.goto('/');
  await openShelf(page);
  const sheet = await openChapters(page);
  await chapterRow(sheet, 'Chapter 9').click();

  const player = page.getByRole('dialog', { name: 'Now playing' });
  await expect(player).toBeVisible();

  /*
   * THREE HAND-OVERS WITH NOBODY WATCHING - which is what listening to a book
   * actually is, and which one hand-over does not prove.
   *
   * A queue that arrives one track deep plays its song and stops, with the
   * skip buttons dead; that has happened here before (the Connect seat used to
   * be handed over without the queue it belongs to). One boundary cannot tell
   * that apart from a book that walks, because the first hand-over works
   * either way when the deck was handed the whole list and only kept the head
   * of it. Three can.
   *
   * Every chapter is eight seconds, so this is half a minute of real wall
   * clock and belongs nowhere near the fast project.
   */
  for (const [file, caption] of [
    ['Chapter 10', 'Chapter 9 of 12'],
    ['Chapter 11', 'Chapter 10 of 12'],
    ['Chapter 12', 'Chapter 11 of 12'],
  ] as const) {
    await expect(player.getByText(caption)).toBeVisible({ timeout: 45_000 });
    expect(streamed).toContain(idOf(file));
  }

  // And the place was kept at every break, not only at the last one: the mark
  // is written as each section is left behind, so a reader who stops after an
  // hour is offered the chapter they stopped in rather than the one they
  // started at.
  for (const left of ['Chapter 9', 'Chapter 10', 'Chapter 11'] as const) {
    await expect
      .poll(
        async () => {
          const states = await hub.get<{
            states: Array<{ trackId: number; positionMs: number }>;
          }>('/api/play-state?kind=book&limit=200');
          return states.states.find((s) => s.trackId === idOf(left))?.positionMs ?? 0;
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(5_000);
  }

  expect(crashes).toEqual([]);
});
