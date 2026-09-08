/**
 * Starting the music HERE, on a hub every suite shares.
 *
 * THE PROBLEM, measured. Playwright gives each test a fresh context, and a
 * fresh context is a new AttackFM Connect device: the id is minted into
 * localStorage on first boot. The hub, meanwhile, holds the playback seat for
 * THIRTY SECONDS after its holder's socket drops - deliberately, so a
 * backgrounded WebView or a blipped proxy does not lose its place to whoever
 * clicks next (connect.rs, SEAT_GRACE_MS). Put together: any test that plays
 * within half a minute of the last one that did arrives as a REMOTE. Its
 * play button then commands a device that closed with the previous test,
 * nothing sounds, and a strip appears for a song nobody is playing. The
 * failure surfaces in whatever suite happens to run next, which is the worst
 * possible place to read it from.
 *
 * There is no quick way out of that seat, either: the hub refuses to hand it
 * to a device that is not connected, and it only opens the seat when the
 * grace lapses. A suite cannot tidy up after itself in less than the grace.
 *
 * THE ANSWER is not to sit in the seat at all. Neither of this agent's suites
 * is about Connect - they are about the app's chrome and about songs arriving
 * - so `soloDeck` cuts the Connect socket for the page, and the deck is
 * simply local: it never claims the seat, never publishes state, and never
 * follows a device that closed ten seconds ago. The suite becomes immune to
 * whatever ran before it AND leaves nothing for whatever runs after, which is
 * the only shape of isolation that works on one shared hub with `workers: 1`.
 *
 * The suites that ARE about Connect (`connect`, `groove`) must obviously not
 * do this. They own that state; this file only declines to.
 *
 * NOT a shared-harness file: it is Agent E's own helper, used by
 * `nav-and-chrome` and `offline-and-downloads`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { World } from './world.ts';

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
