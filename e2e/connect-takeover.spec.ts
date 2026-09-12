/**
 * The bar on the device that WAS playing, after another one takes over.
 *
 * A remote's scrubber is not a picture of anything: it is the hub's last
 * report, carried forward on the remote's own clock. So when the seat moves
 * mid-song and the new holder puts a different song on, every device that is
 * now watching has to be told the new song AND that it is at its beginning -
 * and told by the device that is actually playing it, not by the hub's memory
 * of where the old holder had got to. The report was "the desktop keeps
 * counting up from where its own song was, until the phone skips" - which is a
 * bar that is wrong for a whole song, on the device the listener is looking at.
 *
 * Same shape as connect.spec.ts, and for the same reasons: a hub of its own
 * (the seat outlives the browser that held it), one pair of devices for the
 * file, and the seat read from the HUB rather than from either page.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from './fixtures/hub.ts';
import {
  ConnectWatch,
  firstAccount,
  seedServerSession,
  startSecondHub,
  type HubAccount,
  type SecondHub,
} from './fixtures/registry-and-hubs.ts';
import { cards, seekAt } from './fixtures/deck.ts';
import type { BrowserContext, Locator, Page } from '@playwright/test';

test.use({ connectLive: true });

const DESK = { id: 'e2e-desk-0000-4000-8000-000000000011', name: 'Desk' };
const PHONE = { id: 'e2e-phone-000-4000-8000-000000000012', name: 'Phone' };

/** How far apart two bars may read and still be "the same place": one beat of
 *  the remote's once-a-second tick, plus the round trip. */
const BAR_SLACK_S = 2;

interface Row {
  id: number;
  title: string;
  album: string;
  artist: string;
  duration: number | null;
}

let hub: SecondHub;
let account: HubAccount;
let watch: ConnectWatch;
let deskCtx: BrowserContext;
let phoneCtx: BrowserContext;
let desk: Page;
let phone: Page;
let library: Row[];

/** Every frame on each device's socket, with the runner's clock. This is the
 *  trace that says which side is lying when a bar is wrong. */
const deskFrames: string[] = [];
const phoneFrames: string[] = [];

const seat = () => watch.state?.activeDeviceId ?? null;
const titleOf = (trackId: number | null) =>
  library.find((t) => t.id === trackId)?.title ?? `track ${trackId}`;

const deck = (page: Page): Locator =>
  page.locator('.playerBarShell, [role="dialog"][aria-label="Now playing"]');
/** Where this device's bar says the song is, in seconds - whichever surface is
 *  drawing it. On a device that is only watching, this is the extrapolation. */
const barAt = (page: Page) => seekAt(deck(page).getByRole('slider', { name: 'Seek' }).first());

/** The strip writes "· on Desk"; the dock's device button is NAMED for the
 *  device (the pill that wrote it under the title is gone). */
const saysPlayingOn = async (page: Page, name: string): Promise<boolean> => {
  const text = await page.locator('body').innerText();
  if (text.includes(`· on ${name}`)) return true;
  return (await page.getByRole('button', { name: `Playing on ${name} — change`, exact: true }).count()) > 0;
};

const audible = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('audio')].some((a) => !a.paused && !!a.currentSrc && a.readyState > 0),
  );

async function boot(
  context: BrowserContext,
  device: { id: string; name: string },
  frames?: string[],
): Promise<Page> {
  await seedServerSession(context, account, device);
  // The deck's own elements, narrated: what they loaded, when they sought,
  // when they ended. They mount with the player, later than this script runs,
  // so the observer waits for them. Read back into the trace beside the frames.
  await context.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __afmAudio: string[] }).__afmAudio = log;
    const events = ['loadstart', 'loadedmetadata', 'durationchange', 'play', 'playing', 'pause', 'seeking', 'seeked', 'ended', 'emptied', 'error', 'abort', 'canplay'];
    const seen = new WeakSet<Element>();
    const watchAll = () => {
      document.querySelectorAll('audio').forEach((a, i) => {
        if (seen.has(a)) return;
        seen.add(a);
        for (const ev of events) {
          a.addEventListener(ev, () => {
            log.push(`${new Date().toISOString()} audio#${i} ${ev} ct=${a.currentTime.toFixed(3)} dur=${a.duration} paused=${a.paused} src=${a.currentSrc.slice(-70)}`);
          });
        }
      });
    };
    document.addEventListener('DOMContentLoaded', () => {
      watchAll();
      new MutationObserver(watchAll).observe(document.documentElement, { childList: true, subtree: true });
    });
  });
  const page = await context.newPage();
  if (frames) {
    page.on('websocket', (ws) => {
      if (!/\/api\/connect/.test(ws.url())) return;
      ws.on('framereceived', (frame) => {
        frames.push(`${new Date().toISOString()} <- ${String(frame.payload)}`);
      });
      ws.on('framesent', (frame) => {
        frames.push(`${new Date().toISOString()} -> ${String(frame.payload)}`);
      });
    });
  }
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(page.getByText(`${hub.tracks} songs`)).toBeVisible();
  return page;
}

const audioLog = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __afmAudio?: string[] }).__afmAudio ?? []);

async function openDevices(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).last().click();
  // The TAB, not the text: once Settings has been visited the pane also shows
  // as a recently-used chip, and the words alone then name two controls.
  await page.getByRole('tab', { name: /^Account & devices/ }).click();
  await expect(page.getByText('Play on', { exact: true })).toBeVisible();
}

async function closeSettings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(page.getByText('Play on', { exact: true })).toHaveCount(0);
}

async function playHere(page: Page, device: { name: string }): Promise<void> {
  await openDevices(page);
  await page.getByRole('button', { name: new RegExp(`${device.name} \\(this device\\)`) }).click();
}

/** The desk holding the seat and a few seconds into a song - far enough that a
 *  bar which merely carried on from here would be told apart from one at the
 *  start of a new song. */
async function deskWellIntoASong(): Promise<number> {
  // A test before this one may have left the seat on another device, and a
  // watching desk's Play routes to that device rather than taking the seat -
  // so the seat is asked for back first, the way a listener would.
  if (seat() !== null && seat() !== DESK.id) {
    await playHere(desk, DESK);
    await expect.poll(seat, { timeout: 15_000 }).toBe(DESK.id);
    await closeSettings(desk);
  }
  if (!(seat() === DESK.id && watch.state?.playing === true && (await audible(desk)))) {
    await desk.getByRole('button', { name: 'Library', exact: true }).last().click();
    await desk.getByRole('button', { name: 'Play', exact: true }).first().click();
    await expect.poll(seat, { timeout: 20_000 }).toBe(DESK.id);
    await expect.poll(() => audible(desk), { timeout: 20_000 }).toBe(true);
    await expect.poll(() => saysPlayingOn(phone, DESK.name), { timeout: 20_000 }).toBe(true);
  }
  await expect.poll(() => barAt(desk), { timeout: 20_000 }).toBeGreaterThan(BAR_SLACK_S + 1);
  return watch.state!.trackId!;
}

/**
 * Tap a record on the phone's shelf that is NOT the one playing, and answer
 * with its songs. The shelf card plays the record from its first song, with
 * the shelf as the list - so what the hub should report next is one of these.
 */
async function pickAnotherRecordOn(page: Page, playing: number): Promise<Row[]> {
  await page.getByRole('button', { name: 'Library', exact: true }).last().click();
  const playingAlbum = library.find((t) => t.id === playing)?.album ?? '';
  const shelf = cards(page);
  await expect(shelf.first()).toBeVisible();
  const n = await shelf.count();
  for (let i = 0; i < n; i += 1) {
    const card = shelf.nth(i);
    const face = (await card.innerText()).trim();
    const record = library.filter((t) => t.album && face.startsWith(t.album) && t.album !== playingAlbum);
    if (record.length === 0) continue;
    await card.click();
    return record;
  }
  throw new Error('no record but the one playing is on the shelf');
}

/** The playing element's own clock on this page, in seconds; -1 when silent. */
const deckClock = (page: Page) =>
  page.evaluate(
    () => [...document.querySelectorAll('audio')].find((a) => !a.paused && !!a.currentSrc)?.currentTime ?? -1,
  );

/** Both bars, read as close together as two pages allow, plus the hub's word
 *  and the phone's own element - the one clock that is not a picture. */
async function bars(): Promise<{ desk: number; phone: number; deck: number; hub: number | null }> {
  const [d, p, c] = await Promise.all([barAt(desk), barAt(phone), deckClock(phone)]);
  const at = { desk: d, phone: p, deck: c, hub: watch.state?.positionMs ?? null };
  deskFrames.push(`${new Date().toISOString()} bars desk=${at.desk} phone=${at.phone} phoneDeck=${at.deck} hub=${at.hub}`);
  return at;
}

test.beforeAll(async ({ browser, world }) => {
  hub = await startSecondHub(world, 'Takeover hub', 3);
  account = await firstAccount(hub.url, 'matt', 'attackfm-e2e-matt');
  const index = await fetch(`${hub.url}/api/library?since=0&limit=500`, {
    headers: { authorization: `Bearer ${account.token}` },
  });
  library = ((await index.json()) as { tracks: Row[] }).tracks;
  watch = await ConnectWatch.open(hub.url, account.streamToken);

  const empty = { cookies: [] as never[], origins: [] as never[] };
  deskCtx = await browser.newContext({ baseURL: world.appUrl, storageState: empty });
  phoneCtx = await browser.newContext({ baseURL: world.appUrl, storageState: empty });
  desk = await boot(deskCtx, DESK, deskFrames);
  phone = await boot(phoneCtx, PHONE, phoneFrames);
});

test.afterAll(async () => {
  // The desk's side of the wire, kept where a person can read it: which
  // `state` frames arrived, in what order, carrying whose position.
  const dir = process.env.AFM_E2E_TRACE_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'desk-frames.log'), deskFrames.join('\n') + '\n');
    writeFileSync(join(dir, 'phone-frames.log'), phoneFrames.join('\n') + '\n');
  }
  watch?.close();
  await deskCtx?.close();
  await phoneCtx?.close();
  hub?.stop();
});

test.afterEach(async () => {
  const [d, p] = await Promise.all([audioLog(desk), audioLog(phone)]);
  deskFrames.push(...d.map((l) => `${l} [desk audio]`));
  phoneFrames.push(...p.map((l) => `${l} [phone audio]`));
  await test.info().attach('desk-frames', {
    body: deskFrames.slice(-40).join('\n'),
    contentType: 'text/plain',
  });
});

test('a song picked on the watching device starts at the top on every bar', async () => {
  // THE CONTROL. The pick travels to the desk as a command; the desk plays it
  // and reports it at its beginning. The seat does not move. Every bar reads
  // the new song from the top.
  const before = await deskWellIntoASong();
  const record = await pickAnotherRecordOn(phone, before);
  const ids = record.map((t) => t.id);

  await expect.poll(() => watch.state?.trackId ?? null, { timeout: 20_000 }).not.toBe(before);
  expect(ids).toContain(watch.state!.trackId);
  expect(seat()).toBe(DESK.id);
  await expect
    .poll(async () => (await phone.locator('body').innerText()).includes(titleOf(watch.state!.trackId)), {
      timeout: 20_000,
    })
    .toBe(true);

  await expect
    .poll(
      async () => {
        const at = await bars();
        return Math.abs(at.desk - at.phone) <= BAR_SLACK_S;
      },
      { timeout: 20_000, intervals: [500], message: 'the two bars never agreed after a routed pick' },
    )
    .toBe(true);
});

test.fixme('taking the seat does not replay a pick this device routed to the other one earlier', async () => {
  /*
   * KNOWN BROKEN, found while writing the hand-off test below, and kept here
   * as the reproduction rather than worked around.
   *
   * Run the routed-pick scenario above, then have the phone take the seat with
   * "play here": the phone loads the handed song at the handed place and,
   * about 0.8 s later and with no `ended`, aborts it and loads a song from the
   * record it had PICKED (and routed to the desk) in the earlier scenario,
   * with that record's list as its queue. Measured on 0.6.5 and on this
   * branch alike, and only when a routed pick came first - a phone that has
   * picked nothing hands off cleanly. Where the stale pick lives on a device
   * that never played it is the open question.
   */
  const before = await deskWellIntoASong();
  const record = await pickAnotherRecordOn(phone, before);
  await expect.poll(() => watch.state?.trackId ?? null, { timeout: 20_000 }).not.toBe(before);
  const handed = watch.state!.trackId!;
  expect(record.map((t) => t.id)).toContain(handed);
  await playHere(phone, PHONE);
  await expect.poll(seat, { timeout: 15_000 }).toBe(PHONE.id);
  await closeSettings(phone);
  // Two seconds on, still the handed song on the device that took it.
  await phone.waitForTimeout(2_000);
  expect(watch.state?.trackId).toBe(handed);
});

test('the seat handed over mid-song: the old holder’s bar reads where the new one is', async () => {
  // A phone that has routed a pick replays it when it takes the seat (the
  // fixme above); reloaded so this measures the hand-off and nothing else.
  await phone.reload();
  await expect(phone.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(phone.getByText(`${hub.tracks} songs`)).toBeVisible();
  // THE HAND-OFF ALONE, no new song. The phone takes the seat; the same song
  // carries on there from where the desk had it. From here the desk is a
  // watcher, and the one thing its bar may show is where the phone's deck
  // actually is - read off the phone's own element, not off another picture.
  const before = await deskWellIntoASong();

  await playHere(phone, PHONE);
  await expect.poll(seat, { timeout: 15_000 }).toBe(PHONE.id);
  await expect.poll(() => audible(phone), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => audible(desk), { timeout: 20_000 }).toBe(false);
  expect(watch.state!.trackId).toBe(before);
  await closeSettings(phone);
  await expect.poll(() => saysPlayingOn(desk, PHONE.name), { timeout: 15_000 }).toBe(true);

  // Let the hand-off settle for a couple of the remote's ticks, then hold the
  // desk's bar against the phone's element for a few reads in a row. A single
  // agreeing read can be the instant both happen to pass zero.
  // The agreement has to be on the HANDED song: the fixture's songs are 12
  // to 22 seconds, so one can end inside this window, and two bars both at
  // the top of the next track agree by accident.
  let agreed = 0;
  await expect
    .poll(
      async () => {
        const at = await bars();
        if (at.deck < 0 || watch.state?.trackId !== before) return false;
        agreed = Math.abs(at.desk - at.deck) <= BAR_SLACK_S ? agreed + 1 : 0;
        return agreed >= 3;
      },
      {
        timeout: 12_000,
        intervals: [700],
        message: 'the desk’s bar did not read where the phone’s deck is after the phone took the seat',
      },
    )
    .toBe(true);
});

test('the device that took the seat starts a new song, and the old holder’s bar follows it', async () => {
  // THE REPORT. Desk playing, well in. The phone takes the seat (the same song
  // carries on there, from where it was - that is the hand-off working), and
  // then puts a DIFFERENT record on. Nothing has skipped. The desk is now a
  // watcher, and its bar has to read the phone's song at the phone's place,
  // not its own old song at its own old place ticking on.
  const before = await deskWellIntoASong();

  await playHere(phone, PHONE);
  await expect.poll(seat, { timeout: 15_000 }).toBe(PHONE.id);
  await expect.poll(() => audible(phone), { timeout: 20_000 }).toBe(true);
  await expect.poll(() => audible(desk), { timeout: 20_000 }).toBe(false);
  expect(watch.state!.trackId).toBe(before);
  await closeSettings(phone);
  await expect.poll(() => saysPlayingOn(desk, PHONE.name), { timeout: 15_000 }).toBe(true);

  const record = await pickAnotherRecordOn(phone, before);
  const ids = record.map((t) => t.id);
  await expect.poll(() => watch.state?.trackId ?? null, { timeout: 20_000 }).not.toBe(before);
  const picked = watch.state!.trackId!;
  expect(ids).toContain(picked);
  expect(seat()).toBe(PHONE.id);

  // The desk names the phone's song...
  await expect
    .poll(async () => (await desk.locator('body').innerText()).includes(titleOf(picked)), { timeout: 20_000 })
    .toBe(true);
  // ...and draws its bar where the phone's is. Read together, retried as a
  // pair: a once-a-second remote tick can land between two reads.
  await expect
    .poll(
      async () => {
        const at = await bars();
        return Math.abs(at.desk - at.phone) <= BAR_SLACK_S;
      },
      {
        timeout: 20_000,
        intervals: [500],
        message: 'the desk’s bar did not follow the phone’s after the phone took over and changed the song',
      },
    )
    .toBe(true);
  // Still the same song on the hub - nothing above waited its way through a
  // track change, which would make the agreement an accident of the skip.
  expect(watch.state!.trackId).toBe(picked);
  expect(await audible(desk)).toBe(false);
});

test('a device that starts its own song before its socket is up takes the seat WITH that song', async ({
  browser,
  world,
}) => {
  /*
   * THE SHAPE OF THE REPORT, as a device can actually produce it.
   *
   * A device that is watching routes a pick to the one playing (the control
   * above), so a watching phone never "starts a new song to take over". A
   * phone whose Connect socket is not up yet - the app just opened, or it is
   * on its way back from the background - is not watching: the pick plays
   * right there. Then the socket comes up, the deck reports, and claims the
   * seat for the song it is playing.
   *
   * The hub hands a claimant `becomeActive` carrying the session as it stood
   * - the OLD holder's song and place - and a device that loads whatever it
   * is handed would drop the song it was playing for the desk's, at the
   * desk's position, and report THAT. Every bar then reads the desk's old
   * song ticking on from where the desk left it, until a skip sends a fresh
   * report: the ticket, word for word.
   */
  const LATE = { id: 'e2e-late-0000-4000-8000-000000000013', name: 'Late' };
  const before = await deskWellIntoASong();

  const lateCtx = await browser.newContext({ baseURL: world.appUrl, storageState: { cookies: [], origins: [] } });
  let socketUp = false;
  await lateCtx.routeWebSocket(/\/api\/connect/, (ws) => {
    if (socketUp) ws.connectToServer();
    else ws.close();
  });
  try {
    const late = await boot(lateCtx, LATE);
    const record = await pickAnotherRecordOn(late, before);
    const ids = record.map((t) => t.id);
    await expect.poll(() => audible(late), { timeout: 20_000 }).toBe(true);
    // Not watching, so the pick played HERE, and the desk still has the seat.
    expect(seat()).toBe(DESK.id);
    const lateTitle = (await deck(late).locator('.trackInfo__title, .npScreen__title').first().innerText()).trim();

    // The socket comes up; nudge the reconnect rather than wait out a backoff.
    socketUp = true;
    await late.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(seat, { timeout: 20_000 }).toBe(LATE.id);

    // The seat moved WITH the song that was playing - not the desk's.
    await expect.poll(() => watch.state?.trackId ?? null, { timeout: 15_000 }).not.toBe(before);
    expect(ids).toContain(watch.state!.trackId);
    // And the device that claimed it is still playing what it picked.
    await expect.poll(() => audible(late), { timeout: 10_000 }).toBe(true);
    expect((await deck(late).locator('.trackInfo__title, .npScreen__title').first().innerText()).trim()).toBe(lateTitle);
    await expect.poll(() => audible(desk), { timeout: 20_000 }).toBe(false);

    // The desk's bar reads where the claimant's deck is.
    await expect
      .poll(
        async () => {
          const [d, c] = await Promise.all([barAt(desk), deckClock(late)]);
          return c >= 0 && Math.abs(d - c) <= BAR_SLACK_S;
        },
        { timeout: 15_000, intervals: [500], message: 'the desk’s bar did not follow the device that claimed the seat with its own song' },
      )
      .toBe(true);
  } finally {
    await lateCtx.close();
  }
});
