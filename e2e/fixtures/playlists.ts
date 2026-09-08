/**
 * The gestures `library-and-search` and `playlists` both make.
 *
 * Two suites, one vocabulary: a song row, the menu that hangs off it, which
 * row is playing, and the sweep that takes this run's playlists and hearts
 * back off a hub every other suite is also writing to.
 *
 * Nothing here is a Playwright fixture in the `test.extend` sense - the shared
 * `hub.ts` owns those. These are plain functions over a `Page`, kept in one
 * place because the alternative is the same eleven lines of row-menu
 * choreography copied into two files and drifting.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { HubApi } from './hub.ts';

/**
 * Keep this page out of AttackFM Connect entirely.
 *
 * Call it before the first `goto`, in any test of these two suites.
 *
 * These suites are about a library and the lists made from it, and both mean a
 * single device with nothing else in play. Connect is the opposite of that,
 * and left alone it makes the whole file non-deterministic AND leaks into
 * whatever runs next:
 *
 *   - A device id is a random uuid minted into `localStorage` on first run, so
 *     every fresh browser context is a NEW device to the hub.
 *   - A device that plays takes the session's seat, and the hub HOLDS that seat
 *     for thirty seconds after the socket goes (`SEAT_GRACE_MS`) - deliberately,
 *     because a backgrounded phone is not a phone that has stopped.
 *   - So the next context is a remote of a device that no longer exists.
 *     `ConnectPlayRouter` sends its taps to that ghost instead of playing them,
 *     and the strip mirrors the ghost's last known position forever.
 *
 * Measured, and not subtly: a page that had been asked for one song sat at
 * 13.128 seconds into another one, on a deck that was never going to move
 * again. With no socket there is no device, no seat, and no ghost - the page
 * plays what it is told to play, and the hub is left exactly as it was found,
 * which is what keeps this out of the next suite's run.
 *
 * The socket is INTERCEPTED rather than refused: a mock that never speaks
 * leaves the client waiting quietly, where closing it would put `ConnectSocket`
 * into its reconnect backoff for the length of the test.
 *
 * THE REAL FIX IS ONE LINE OF GLOBAL-SETUP - seed `attackfm-device-id` into
 * each account's storage state, so every context of one user is that user's one
 * device coming back and the seat is always reclaimed rather than orphaned.
 * That belongs to the shared harness; this is the half a suite can do for
 * itself.
 */
export async function noConnect(page: Page): Promise<void> {
  await page.routeWebSocket(/\/api\/connect/, () => {
    // Deliberately empty: accept the socket, never dial the hub, never answer.
  });
}

/**
 * The TITLE cell of a song row, named the way the accessibility tree names it.
 *
 * Title and artist together, exactly: a title alone is ambiguous in this
 * fixture and in any real library. "Longhand" is a song by Marla Vane, an
 * album by Marla Vane, and the album cell of "Fountain Pen Blues" - and the
 * album cell comes FIRST in document order, so `getByRole('gridcell', { name:
 * /^Longhand/ }).first()` reads the wrong row. The title cell is the only one
 * that announces both, so both is what identifies it.
 */
export function songCell(scope: Page | Locator, title: string, artist: string): Locator {
  return scope.getByRole('gridcell', { name: `${title} ${artist}`, exact: true });
}

/**
 * A whole song row, found through its title cell.
 *
 * Never by the row's own accessible name: a row announces every cell it has,
 * so `getByRole('row', { name: /Ember Days/ })` matches the row whose ALBUM is
 * Ember Days before it reaches the song of that name - which selects the wrong
 * song, and (in selection mode) silently toggles one row twice while missing
 * another. Measured: nine picks came out as five.
 */
export function songRow(scope: Page | Locator, title: string, artist: string): Locator {
  return scope.getByRole('row').filter({ has: songCell(scope, title, artist) });
}

/**
 * A song row's menu, open.
 *
 * The gesture is a `contextmenu` event on the title cell, which is the app's
 * OWN mechanism: `useHoldToMenu` answers a press-and-hold by dispatching
 * exactly this event at the pointer's coordinates, because the menu wraps the
 * title cell alone and a hold anywhere else on a wide row has to be forwarded
 * to it. Driving it the same way is not a shortcut past the UI - it is the
 * same door a thumb goes through.
 *
 * A synthetic right-CLICK is what does not work, and the reason is worth
 * writing down. The kit's ContextMenu dismisses on any scroll (it is anchored
 * to a point in the viewport, so a scrolled page would leave it hanging over
 * nothing), and Playwright scrolls the target into view before every click.
 * The scroll event lands about 25 ms AFTER the menu opens, so the menu opens
 * and closes again inside a couple of frames - measured, repeatedly. The
 * panel is then also anchored at the pointer, where Playwright's own hover
 * before the item click keeps it moving, and the item never passes the
 * stability check.
 */
export async function openRowMenu(page: Page, title: string, artist: string): Promise<Locator> {
  const cell = songCell(page, title, artist);
  await expect(cell).toBeVisible();
  await cell.dispatchEvent('contextmenu');
  const menu = page.getByRole('menu', { name: `${title} actions` });
  await expect(menu).toBeVisible();
  return menu;
}

/** Open a song's menu and pick one of its first-level items. */
export async function rowMenuItem(
  page: Page,
  title: string,
  artist: string,
  item: string | RegExp,
): Promise<void> {
  const menu = await openRowMenu(page, title, artist);
  await menu.getByRole('menuitem', { name: item }).click();
}

/** Open a song's menu and pick something from behind "More…". */
export async function rowMenuMore(
  page: Page,
  title: string,
  artist: string,
  item: string | RegExp,
): Promise<void> {
  const menu = await openRowMenu(page, title, artist);
  await menu.getByRole('menuitem', { name: 'More…' }).click();
  await page.getByRole('menu', { name: 'More…' }).getByRole('menuitem', { name: item }).click();
}

/**
 * The song the tables say is playing, by the row wearing `aria-current`.
 *
 * The bars beside the name are `aria-hidden` decoration that leans on this
 * attribute (SongTable's own comment says so), which makes it the one
 * published contract for "this row is the one on" - and it is a row in the
 * list you are looking at, so it answers "did the tap open the row I pointed
 * at" in a way the Now Playing sheet cannot.
 */
export function playingRow(page: Page): Locator {
  return page.locator('[aria-current="true"]');
}

/** The playing row's title, without the artist line under it. */
export async function playingTitle(page: Page): Promise<string> {
  return (await playingRow(page).locator('.songTitle__name').first().innerText()).trim();
}

export interface HubPlaylist {
  id: number;
  name: string;
  tracks?: number[];
  folder?: string;
  description?: string;
  cover?: string | null;
  coverUrl?: string | null;
}

/** Every playlist the hub holds for this account. */
export async function hubPlaylists(hub: HubApi): Promise<HubPlaylist[]> {
  const reply = await hub.get<{ playlists: HubPlaylist[] }>('/api/playlists');
  return reply.playlists ?? [];
}

/**
 * Take every list whose name starts with `prefix` off the hub.
 *
 * One hub serves every suite in the run and the workers are serialised, so a
 * playlist left behind is a playlist the next suite counts. Named rather than
 * remembered by id so a test that died halfway still gets swept.
 */
export async function sweepPlaylists(hub: HubApi, prefix: string): Promise<void> {
  for (const list of await hubPlaylists(hub)) {
    if (list.name.startsWith(prefix)) await hub.delete(`/api/playlists/${list.id}`);
  }
}

/** Un-heart everything this account has hearted. */
export async function clearFavourites(hub: HubApi): Promise<void> {
  const reply = await hub.get<{ tracks: number[] }>('/api/favorites');
  for (const id of reply.tracks ?? []) await hub.put(`/api/favorites/${id}`, { favorite: false });
}

/**
 * The MUSIC in the library, newest first.
 *
 * `added_at` is the HUB's insert clock, stamped as it walks the folder, so the
 * order of the fixture array is only the order the records were WRITTEN - a
 * suite that has added or moved anything must read the order back rather than
 * assume it. See the note on ALBUMS in fixtures/media.ts.
 *
 * The book's chapters are dropped here for the same reason the shelves drop
 * them: `/api/library` carries every row the hub holds, and the book is the
 * newest thing in it (global-setup writes `Audiobooks/` last), so a shelf
 * compared against the unfiltered index disagrees on its very first card.
 */
export async function newestFirst(hub: HubApi): Promise<Array<{ title: string; artist: string; album: string }>> {
  const tracks = await hub.tracks();
  return tracks
    .filter((t) => t.kind !== 'book')
    .sort((a, b) => (b.addedAt as number) - (a.addedAt as number))
    .map((t) => ({ title: t.title as string, artist: t.artist as string, album: t.album as string }));
}
