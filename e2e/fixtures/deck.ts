/**
 * What the deck, groove, nav and downloads suites all have to do before they
 * can assert anything: start the music HERE, stop it again, reach the library
 * as a known device, get a track menu open, and read what is actually playing.
 *
 * Two suites' helpers met in this file when their branches landed together,
 * and they belong together: they are the same job seen from two sides. The
 * Connect notes below are kept verbatim from both, because they are the
 * measured history of the most expensive trap in this harness - and the
 * general answer now lives in `hub.ts` as the `connectLive` fixture, which
 * answers the socket and says nothing for every file that has not asked for
 * it. `soloDeck` predates that and is now belt as well as braces; the device
 * pinning below is still worth having, because a suite that DOES want Connect
 * live wants to be the same device each time rather than a new one.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { HubApi, type World } from './hub.ts';

/**
 * Take this page out of AttackFM Connect for the run.
 *
 * The socket is answered and dropped rather than left hanging: the client
 * reconnects on a capped backoff either way, and a socket that never opens is
 * the state the app already handles everywhere (a hub too old for Connect, a
 * proxy that will not upgrade). `connected` stays false, so `isRemote` is
 * false, so every transport press lands on this device's own deck.
 *
 * Must be called before the first `goto`.
 */
export async function soloDeck(page: Page, world: World): Promise<void> {
  const socket = `${world.hubUrl.replace(/^http/i, 'ws')}/api/connect*`;
  await page.routeWebSocket(socket, (ws) => ws.close());
}

/** Is this device's own <audio> actually running? */
const SOUNDING = () => {
  const audio = document.querySelector('audio');
  return !!audio && !audio.paused && audio.currentTime > 0;
};

/**
 * Press `play` and wait until sound is actually coming out.
 *
 * Returns once the local element is past zero, so a caller can assert on the
 * strip, the dock or the seek control without racing the first frame. The
 * fixture tracks are 19 kB of silence served off localhost, so anything that
 * takes longer than this is broken rather than slow.
 */
export async function playHere(page: Page, play: Locator): Promise<void> {
  await play.click();
  await expect
    .poll(
      async () => page.waitForFunction(SOUNDING, undefined, { timeout: 2_000 }).then(() => true, () => false),
      { timeout: 20_000 },
    )
    .toBe(true);
}

/** Put it down again, so the next test is not handed a running deck. */
export async function pauseHere(page: Page): Promise<void> {
  const pause = page.getByRole('button', { name: 'Pause' }).first();
  if (await pause.count()) await pause.click();
}

/**
 * One device per person, for both of these suites.
 *
 * Two reasons, and the second one is why the accounts are `ana` and `kim`
 * rather than the default `matt`. A Connect seat OUTLIVES the context that
 * held it - `SEAT_GRACE_MS` in the hub's connect.rs is thirty seconds, so that
 * a backgrounded phone does not lose its seat to a doorway - which means a
 * spec that plays music leaves the account's seat warm for whatever runs in
 * the next half-minute. Any later page signed in as the SAME account opens
 * mirroring it: a strip carrying somebody else's song, and no deck of its own.
 * Files run in alphabetical order, and `smoke.spec.ts` runs after these two,
 * so leaving matt engaged breaks the harness's own spec. These suites keep off
 * matt entirely, and share one device per account between them.
 */
export const DEVICE = { ana: 'e2e-a-ana', kim: 'e2e-a-kim' } as const;

/**
 * Be the same device every time.
 *
 * Playwright gives each test a fresh context, and a fresh context mints a
 * fresh `attackfm-device-id` - so by the second test the hub has two of this
 * account's devices on file, the first one still holds the Connect seat, and
 * the new page opens as a WATCHER: no deck of its own, no docked Now Playing,
 * and a strip that reads "on Chrome on Windows PC". Every assertion here is
 * about a device playing its own music, so every page in the suite is the
 * SAME device, which is also what one person at one desk actually is.
 *
 * Seeded before the bundle evaluates, the same way the session is. Two suites
 * that want to be two devices pass two ids - which is what the groove suite
 * does for its host and its guest.
 */
export async function asDevice(page: Page, id: string): Promise<void> {
  await page.addInitScript((deviceId: string) => {
    try {
      localStorage.setItem('attackfm-device-id', deviceId);
    } catch {
      // A context with storage blocked will simply mint its own; the suite
      // that cares says so by failing on the watcher strip.
    }
  }, id);
}

/**
 * The library, painted and settled.
 *
 * "Settled" is load-bearing rather than politeness. The shelf's covers arrive
 * over twelve separate requests and each one that lands can move the page a
 * few pixels; the kit's ContextMenu closes itself on ANY scroll (its own
 * dismissal rule), so a menu opened while the art is still landing is a menu
 * that vanishes ~200 ms later. Waiting for the last card of the shelf to exist
 * is the cheapest proof the run is over.
 */
export async function openLibrary(page: Page, deviceId: string): Promise<void> {
  await asDevice(page, deviceId);
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect(cards(page).nth(11)).toBeVisible();
}

/** The Recently added shelf, newest first - twelve cards for twelve songs. */
export function cards(page: Page): Locator {
  return page.locator('.trackCard');
}

/** The full-screen (on a desktop shape, docked) Now Playing surface. */
export function nowPlaying(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Now playing' });
}

/** The song named on the Now Playing surface. */
export async function sheetTitle(page: Page): Promise<string> {
  return (await nowPlaying(page).locator('.npScreen__title').first().innerText()).trim();
}

/**
 * Open a song's context menu and choose a row, answering with the song's name.
 *
 * The name comes off the menu panel's own accessible label (`"<title>
 * actions"`), which is the only place on a shelf card the TITLE appears - the
 * card face shows the ALBUM. That matters because two of the fixture's records
 * share an artist and one shares its name with a song on it, so "the card I
 * right-clicked" is not otherwise a title a test can assert on.
 *
 * Retried as a whole because of the scroll-dismissal above: focusing a card
 * that is not fully in view scrolls the shelf, and the scroll shuts the menu
 * between the right-click and the row's click. One more try, with the card now
 * where it was scrolled to, always lands. The click on the row is the LAST
 * thing in the block on purpose - a retry can therefore never queue the same
 * song twice.
 */
export async function fromTrackMenu(page: Page, card: Locator, row: string): Promise<string> {
  let title = '';
  await expect(async () => {
    await card.scrollIntoViewIfNeeded();
    await card.focus();
    await card.click({ button: 'right' });
    const menu = page.getByRole('menu').last();
    await expect(menu).toBeVisible({ timeout: 2_000 });
    title = ((await menu.getAttribute('aria-label')) ?? '').replace(/ actions$/, '');
    expect(title).not.toBe('');
    await page.getByRole('menuitem', { name: row, exact: true }).click({ timeout: 2_000 });
  }).toPass({ timeout: 25_000 });
  return title;
}

/** What the deck is telling the operating system, which is what a lock screen,
 *  Control Center and CarPlay all render. */
export async function systemNowPlaying(
  page: Page,
): Promise<{ title: string; artist: string; album: string; state: string }> {
  return page.evaluate(() => {
    const media = navigator.mediaSession;
    const meta = media.metadata;
    return {
      title: meta?.title ?? '',
      artist: meta?.artist ?? '',
      album: meta?.album ?? '',
      state: String(media.playbackState ?? ''),
    };
  });
}

/** Every media element on the page, which is where "it is really playing"
 *  stops being a matter of what a button's label says. */
export async function audioState(
  page: Page,
): Promise<Array<{ at: number; paused: boolean; src: string }>> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLAudioElement>('audio')).map((el) => ({
      at: el.currentTime,
      paused: el.paused,
      src: el.getAttribute('src') ?? '',
    })),
  );
}

/** Where the deck is, in seconds, off the control a screen reader is given. */
export async function seekAt(seek: Locator): Promise<number> {
  return Number(await seek.getAttribute('aria-valuenow'));
}

/** How long the file is, the same way. */
export async function seekMax(seek: Locator): Promise<number> {
  return Number(await seek.getAttribute('aria-valuemax'));
}

/**
 * Put the deck a few seconds from the end, and let the file finish by itself.
 *
 * The obvious shortcut - `End` on the seek control - is wrong, and it took
 * four red runs to see why. Setting the position to the exact duration does
 * not reliably raise `ended`: for some files the element simply sits at the
 * end, paused, and the deck never advances at all. Repeat OFF passes anyway
 * (stopping is what it wanted), repeat ONE passes anyway (it returns early),
 * and repeat ALL fails - so the shortcut turns "the wrap is broken" and "the
 * seek did not end the file" into the same red, which is the least useful
 * kind of test failure there is.
 *
 * So it steps to within a few seconds and waits: a real `ended`, from a file
 * that really ran out, down the same path a listener's does - including the
 * warm-up the deck does inside the last twelve seconds, which is the half a
 * jump to the end skips entirely.
 *
 * The wait before stepping is not politeness either. Until the element has
 * its metadata the control's range is 0..0, so every step is a seek to zero.
 */
export async function seekNearTheEnd(seek: Locator, within = 6): Promise<void> {
  await expect
    .poll(async () => (await seekMax(seek)) > 5 && (await seekAt(seek)) > 0.5, { timeout: 20_000 })
    .toBe(true);
  const total = await seekMax(seek);
  await seek.focus();
  // The control's own step is five seconds, so this lands inside `within`
  // without ever stepping past the end.
  for (let i = 0; i < 12; i += 1) {
    if ((await seekAt(seek)) >= total - within) return;
    await seek.press('ArrowRight');
  }
  throw new Error(`e2e: could not step to within ${within}s of ${total}s`);
}

/** The hub's own API as somebody other than the file's signed-in user - which
 *  is how a two-person scenario cleans up after both of them. */
export function apiAs(world: World, username: string): HubApi {
  const token = world.tokens[username];
  if (!token) throw new Error(`e2e: no fixture account called ${username}`);
  return new HubApi(world.hubUrl, token);
}

/**
 * Close every room these accounts are in.
 *
 * One hub serves every suite in the run (`workers: 1`, one world), so a groove
 * left open is a groove the next suite's first `/api/jams` poll walks into -
 * and "the nearby offer appears once" is not a thing a spec can assert while
 * somebody else's room is still standing. Ending is the host's verb and
 * leaving is everyone else's; both are tried and neither is allowed to fail
 * the test, because the usual case is that there is nothing to close.
 */
export async function closeRooms(...apis: HubApi[]): Promise<void> {
  for (const api of apis) {
    let id: string | null = null;
    try {
      const feed = await api.get<{ current?: { id?: string } | null }>('/api/jams');
      id = feed.current?.id ?? null;
    } catch {
      // The hub is gone or the token is not this hub's: nothing to close.
    }
    if (!id) continue;
    try {
      await api.post(`/api/jams/${id}/end`);
    } catch {
      // Not the host - leaving is the way out.
    }
    try {
      await api.post(`/api/jams/${id}/leave`);
    } catch {
      // Already out, or the room ended under us. Either way it is closed.
    }
  }
}
