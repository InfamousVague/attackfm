/**
 * One account, two devices, one thing playing.
 *
 * AttackFM Connect's whole contract is the SEAT: at most one device decodes
 * audio, every other device shows what it is doing and can drive it, and the
 * hub owns which is which. Nearly every bug this area has had was a
 * disagreement about the seat - a phone that believed it was a remote for the
 * purpose of drawing the strip and a local player for the purpose of playing a
 * song, a queue add that started the song on the watching device and stole the
 * seat mid-listen, a hand-off that seeked past the end of the track and came
 * back silent. So the assertions here are mostly about the seat, and they are
 * read from the HUB rather than from either browser: a device's own opinion of
 * who is playing is precisely the thing that has been wrong before.
 *
 * TWO STRUCTURAL DECISIONS.
 *
 * 1. THIS SUITE STANDS UP ITS OWN HUB. A device that drops while holding the
 *    seat keeps it for a 30 s grace (SEAT_GRACE_MS, connect.rs) - deliberately,
 *    because a dropped socket says nothing about a media pipeline. That is
 *    correct, and it is also a booby trap for every suite that runs next: they
 *    would connect to the shared hub, find a seat held by a browser that no
 *    longer exists, and mirror it instead of playing. On a hub of its own,
 *    closing the browser at the end costs nobody anything.
 *
 * 2. ONE PAIR OF DEVICES FOR THE WHOLE FILE, and the tests run in order. The
 *    seat is a running fact, so each test leaves it where the next one expects
 *    it - which is also how a listener's evening goes.
 */
import { expect, test } from './fixtures/hub.ts';
import {
  ConnectWatch,
  firstAccount,
  seedServerSession,
  startSecondHub,
  type HubAccount,
  type SecondHub,
} from './fixtures/registry-and-hubs.ts';
import type { BrowserContext, Locator, Page } from '@playwright/test';

/** Stable ids so the hub, the picker and these assertions all mean the same
 *  device by the same word. Two contexts of one browser would otherwise mint
 *  two random ids and derive the same name for both, and a picker with two
 *  identical rows is not something a test can point at. */
const DESK = { id: 'e2e-desk-0000-4000-8000-000000000001', name: 'Desk' };
const PHONE = { id: 'e2e-phone-000-4000-8000-000000000002', name: 'Phone' };

interface Row {
  id: number;
  title: string;
  album: string;
  artist: string;
}

let hub: SecondHub;
let account: HubAccount;
let watch: ConnectWatch;
let deskCtx: BrowserContext;
let phoneCtx: BrowserContext;
let desk: Page;
let phone: Page;
let library: Row[];

/** The hub's own answer. Every seat assertion goes through this. */
const seat = () => watch.state?.activeDeviceId ?? null;
const titleOf = (trackId: number | null) =>
  library.find((t) => t.id === trackId)?.title ?? `track ${trackId}`;

/**
 * THE TRANSPORT, wherever this device is currently keeping it.
 *
 * Two shapes, and which one a device is wearing depends on whether it is the
 * one playing: a device with its own deck engaged shows the docked Now Playing
 * panel, and a device that is only mirroring shows the plain strip. Both are
 * matched here, and only one of them is ever in the accessibility tree - the
 * strip's controls go aria-hidden under the dock - so a role query inside this
 * still resolves to exactly one control.
 *
 * Addressed by class rather than by a test id of my own: `.playerBarShell` is
 * the strip's own root and already what the app's stylesheet finds it by, so
 * this pins nothing that was not pinned already.
 */
const deck = (page: Page): Locator =>
  page.locator('.playerBarShell, [role="dialog"][aria-label="Now playing"]');
/** "Previous"/"Next" in the dock, "Previous track"/"Next track" on the strip. */
const NEXT = /^Next( track)?$/;

/**
 * What this device says about where the music is.
 *
 * The two surfaces word it differently - the strip writes "· on Desk" beside
 * the artist, the dock writes "Playing on Desk" under the title - and which one
 * a device is wearing changes as the seat moves. Read off `innerText`, which is
 * the rendered text and therefore never the hidden copy of the other surface.
 */
const saysPlayingOn = async (page: Page, name: string): Promise<boolean> => {
  const text = await page.locator('body').innerText();
  return text.includes(`\u00b7 on ${name}`) || text.includes(`Playing on ${name}`);
};

/** Whether this browser is making a sound: the deck's own elements, not the
 *  picture the strip is drawing. A mirroring device draws a running scrubber
 *  and must be silent while it does. */
const audible = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('audio')].some((a) => !a.paused && !!a.currentSrc && a.readyState > 0),
  );

async function boot(context: BrowserContext, device: { id: string; name: string }): Promise<Page> {
  await seedServerSession(context, account, device);
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  // The library has to be in hand before any of this means anything: a remote
  // turns the hub's track id back into a row out of `allTracks`, and a device
  // that has not synced yet cannot mirror, cannot be handed the seat, and
  // cannot resolve a song somebody queued at it.
  await expect(page.getByText(`${hub.tracks} songs`)).toBeVisible();
  return page;
}

/** Settings -> Account & devices, where the device rows live. The player's own
 *  picker mounts the same component behind a popover; this door is the one that
 *  is a plain list of buttons. */
async function openDevices(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  await page.getByText('Account & devices').click();
  await expect(page.getByText('Play on', { exact: true })).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByText('Play on', { exact: true })).toHaveCount(0);
}

/** "Play here", on the row for this device. */
async function playHere(page: Page, device: { name: string }): Promise<void> {
  await openDevices(page);
  await page.getByRole('button', { name: new RegExp(`${device.name} \\(this device\\)`) }).click();
}

/**
 * The desk holding the seat and playing - the state the file's later scenarios
 * open on.
 *
 * Spelled out rather than left to whichever test ran before, because the `slow`
 * project runs ONLY the two tagged tests: everything that set the scene in a
 * fast run is skipped there, and a scenario that silently depends on it passes
 * in one project and fails in the other. Pressing play while another device
 * holds the seat claims it (usePlayerConnect transfers first), so this is one
 * path from any starting point.
 */
async function deskPlaying(): Promise<void> {
  if (seat() === DESK.id && watch.state?.playing === true && (await audible(desk))) return;
  await desk.getByRole('button', { name: 'Library', exact: true }).last().click();
  await desk.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect.poll(seat, { timeout: 20_000 }).toBe(DESK.id);
  await expect.poll(() => watch.state?.playing ?? false, { timeout: 20_000 }).toBe(true);
  await expect.poll(() => audible(desk), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => saysPlayingOn(phone, DESK.name), { timeout: 20_000 }).toBe(true);
}

test.beforeAll(async ({ browser, world }) => {
  hub = await startSecondHub(world, 'Connect hub', 3);
  account = await firstAccount(hub.url, 'matt', 'attackfm-e2e-matt');
  const index = await fetch(`${hub.url}/api/library?since=0&limit=500`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  library = ((await index.json()) as { tracks: Row[] }).tracks;
  watch = await ConnectWatch.open(hub.url, account.streamToken);

  const empty = { cookies: [] as never[], origins: [] as never[] };
  deskCtx = await browser.newContext({ baseURL: world.appUrl, storageState: empty });
  phoneCtx = await browser.newContext({ baseURL: world.appUrl, storageState: empty });
  desk = await boot(deskCtx, DESK);
  phone = await boot(phoneCtx, PHONE);
});

test.afterAll(async () => {
  watch?.close();
  await deskCtx?.close();
  await phoneCtx?.close();
  hub?.stop();
});

test('a second device mirrors the first, and does not play a note of its own', async () => {
  await desk.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect(deck(desk).getByRole('button', { name: 'Pause' })).toBeVisible();

  // The seat is claimed by REPORTING, not by opening the app: two devices had
  // been signed in for a while and neither held it until one pressed play.
  await expect.poll(seat, { timeout: 15_000 }).toBe(DESK.id);
  await expect.poll(() => audible(desk), { timeout: 15_000 }).toBe(true);

  // What the phone shows is the desk's song, and it says whose it is. "· on
  // Desk" is the one line separating "this device is playing" from "this device
  // is a remote", and it is what a listener reads before pressing pause.
  await expect.poll(() => saysPlayingOn(phone, DESK.name)).toBe(true);
  await expect
    .poll(async () => (await phone.locator('body').innerText()).includes(titleOf(watch.state!.trackId)))
    .toBe(true);

  // And the phone is silent. A mirroring device draws a live scrubber, which is
  // exactly why "it looks like it is playing" is not the assertion.
  expect(await audible(phone)).toBe(false);
});

test('the seat moves to the device that asks for it, mid-song, and comes back', async () => {
  // Far enough in that a hand-off which restarted the song would be obvious.
  await expect
    .poll(async () => Number(await deck(desk).getByRole('slider', { name: 'Seek' }).getAttribute('aria-valuenow')), {
      timeout: 20_000,
    })
    .toBeGreaterThan(2);
  const song = watch.state!.trackId;

  await playHere(phone, PHONE);
  await expect.poll(seat, { timeout: 15_000 }).toBe(PHONE.id);
  // Same song, and it picked up where it was rather than from the top. The hub
  // advances the stored position to the moment of the hand-off precisely so
  // this is true; without it the new device restarts the track.
  expect(watch.state!.trackId).toBe(song);
  await expect.poll(() => watch.state?.positionMs ?? 0).toBeGreaterThan(1_500);
  await expect.poll(() => audible(phone), { timeout: 20_000 }).toBe(true);

  // The device it came from stops. Two devices playing at once is the failure
  // this half exists to prevent.
  await expect.poll(() => audible(desk), { timeout: 20_000 }).toBe(false);
  await expect.poll(() => saysPlayingOn(desk, PHONE.name), { timeout: 15_000 }).toBe(true);
  await closeSettings(phone);

  // ...and back, which is its own bug: a device handed the seat while it was
  // only mirroring has no deck of its own to seek, and the hand-back used to
  // land on the last frame of the song, paused, with the bar gone.
  await playHere(desk, DESK);
  await expect.poll(seat, { timeout: 15_000 }).toBe(DESK.id);
  await expect.poll(() => audible(desk), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => watch.state?.playing ?? false).toBe(true);
  await closeSettings(desk);
  await expect.poll(() => saysPlayingOn(phone, DESK.name), { timeout: 15_000 }).toBe(true);
});

test('a remote drives the device that is playing, and hears the answer', async () => {
  // Pause, from the device that is NOT playing. The press stops nothing here -
  // there is nothing here to stop - it travels.
  await deck(phone).getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => watch.state?.playing ?? true, { timeout: 15_000 }).toBe(false);
  await expect.poll(() => audible(desk), { timeout: 15_000 }).toBe(false);
  // And the seat did not move to press its own pause button.
  expect(seat()).toBe(DESK.id);

  await deck(phone).getByRole('button', { name: 'Play', exact: true }).click();
  await expect.poll(() => watch.state?.playing ?? false, { timeout: 15_000 }).toBe(true);
  await expect.poll(() => audible(desk), { timeout: 15_000 }).toBe(true);

  const before = watch.state!.trackId;
  await deck(phone).getByRole('button', { name: NEXT }).click();
  await expect.poll(() => watch.state?.trackId ?? null, { timeout: 15_000 }).not.toBe(before);
  // Still the desk's deck that moved, and the desk that is showing it.
  expect(seat()).toBe(DESK.id);
  await expect
    .poll(async () => (await desk.locator('body').innerText()).includes(titleOf(watch.state!.trackId)))
    .toBe(true);
});

test('adding to the queue from a watching device asks, instead of taking over', async () => {
  // THE REGRESSION. "Add to queue" on a device that is mirroring used to fall
  // into the local verb's nothing-is-playing shortcut (`current` is null by
  // design while mirroring), start the song HERE, and claim the seat with the
  // report that followed - which pauses whoever held it. Reported as "it
  // started playing right away", and nothing to do with the menu that raised
  // it. See queueControls.tsx.
  const before = { seat: seat(), track: watch.state!.trackId, epoch: watch.state!.epoch };

  // A record that is NOT the one on, so "the queue grew" cannot be confused
  // with "the rest of this album was in the list already" - and one the shelf
  // is actually showing, since Recently added holds a handful rather than the
  // whole library.
  await phone.getByRole('button', { name: 'Library', exact: true }).last().click();
  const playingAlbum = library.find((t) => t.id === before.track)?.album ?? '';
  const records = [...new Map(library.map((t) => [`${t.album}\u0000${t.artist}`, t])).values()];
  let card = phone.getByRole('button', { name: 'nothing' });
  let record: Row[] = [];
  for (const candidate of records) {
    if (candidate.album === playingAlbum) continue;
    const shelf = phone.getByRole('button', { name: `${candidate.album} ${candidate.artist}` }).first();
    if ((await shelf.count()) === 0) continue;
    card = shelf;
    record = library.filter((t) => t.album === candidate.album && t.artist === candidate.artist);
    break;
  }
  expect(record.length, 'no album but the one playing is on the shelf').toBeGreaterThan(0);
  await expect(card).toBeVisible();
  /*
   * A right-click IS the hold gesture: `useHoldToMenu` summons the menu by
   * dispatching `contextmenu`, so a mouse's context menu and a thumb's long
   * press arrive at identical code.
   *
   * Retried as a pair because a MIRRORING device re-renders once a second -
   * that is the remote's own clock, ticking between the seat holder's reports
   * - and a tick that lands between the menu opening and the item being
   * pressed takes the menu with it. Reopening is what a person does too. A
   * repeat is harmless: the receiving deck folds in only the songs its lane
   * does not already hold.
   */
  await expect(async () => {
    await card.click({ button: 'right' });
    await phone.getByRole('menuitem', { name: 'Add to queue' }).click({ timeout: 2_000 });
  }).toPass({ timeout: 30_000, intervals: [400] });

  // The songs reached the deck that is actually playing, and they sit behind
  // what is on rather than replacing it: the wire carries [now, ...by hand,
  // ...the rest of the list].
  const ids = record.map((t) => t.id);
  await expect
    .poll(() => (watch.state?.queue ?? []).filter((id) => ids.includes(id)).length, { timeout: 20_000 })
    .toBe(ids.length);
  expect(watch.state!.queue[0]).toBe(before.track);

  // Nothing about playback moved. Same seat, same epoch (a transfer bumps it),
  // same song - and the phone is still silent and still says whose deck it is
  // watching.
  expect(seat()).toBe(before.seat);
  expect(watch.state!.epoch).toBe(before.epoch);
  expect(watch.state!.trackId).toBe(before.track);
  expect(await audible(phone)).toBe(false);
  expect(await saysPlayingOn(phone, DESK.name)).toBe(true);
});

test('@slow the watching device follows the seat holder across track changes', async () => {
  /*
   * Half a minute of somebody else's listening, watched from a second device.
   *
   * The mirror is not a screenshot: the remote extrapolates the position from
   * the last report and only learns a NEW song when the seat holder publishes
   * one, so a report that stops going out (the gate is `playing || ownsPlayback`
   * and it has collapsed before) leaves the watching device showing a song that
   * finished thirty seconds ago, with a scrubber still running under it. That
   * is invisible in any test short enough to fit inside one track, which is why
   * this one waits for real track boundaries.
   */
  await deskPlaying();
  let current = watch.state!.trackId;

  for (let change = 0; change < 2; change += 1) {
    const previous = current;
    // The fixture's songs are 12-22 s, so the deck reaches the next one on its
    // own well inside this - and reaching it AT ALL is half the assertion: an
    // advance that never publishes is a queue that has stopped syncing.
    await expect
      .poll(() => watch.state?.trackId ?? null, { timeout: 60_000, intervals: [500] })
      .not.toBe(previous);
    current = watch.state!.trackId;

    await expect
      .poll(async () => (await phone.locator('body').innerText()).includes(titleOf(current)), {
        timeout: 20_000,
      })
      .toBe(true);
    // ...and none of it moved the seat or woke the watcher's own deck.
    expect(seat()).toBe(DESK.id);
    expect(await audible(phone)).toBe(false);
    expect(await saysPlayingOn(phone, DESK.name)).toBe(true);
  }
});

test('@slow a device that vanishes keeps its seat through the grace, then loses it', async () => {
  await deskPlaying();
  expect(seat()).toBe(DESK.id);

  await deskCtx.close();

  // NOT instantly. A dropped WebSocket says nothing about a media pipeline, and
  // opening the seat the moment a socket blipped is the seat-stealing bug: a
  // remote pressing play during a two-second gap played locally, took the seat,
  // and was paused right back when the phone returned.
  await expect
    .poll(() => watch.devices.find((d) => d.id === DESK.id)?.online ?? true, { timeout: 20_000 })
    .toBe(false);
  expect(seat()).toBe(DESK.id);

  // ...and then it does open, and the session stops claiming to be playing.
  await expect.poll(seat, { timeout: 60_000, intervals: [1_000] }).toBeNull();
  expect(watch.state!.playing).toBe(false);

  // Which the phone reads as "nothing is playing anywhere" rather than "still
  // on the Desk": an empty seat is a LOCAL state, and a device that keeps
  // mirroring a machine that has gone is a device that cannot play a song.
  await expect.poll(() => saysPlayingOn(phone, DESK.name), { timeout: 20_000 }).toBe(false);
  await phone.getByRole('button', { name: 'Library', exact: true }).last().click();
  await phone.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect.poll(seat, { timeout: 20_000 }).toBe(PHONE.id);
  await expect.poll(() => audible(phone), { timeout: 20_000 }).toBe(true);
});
