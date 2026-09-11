/**
 * The disc while the song is still loading.
 *
 * A buffering deck spools the platter: it runs several times faster than a
 * playing one, the way a drive whirrs while it seeks, and coasts back down
 * once the bytes arrive. "Slightly faster" was the bug this guards against,
 * and it is one a component test cannot see - the prop is fed from the deck's
 * own `buffering`, which the audio element's events and the retry ladder
 * arm, so the only honest oracle is the face of the disc in the real app
 * with the real stream held back.
 *
 * The deck is made to buffer the way a dropped connection makes it buffer:
 * the first stream request FAILS, which puts the deck on its retry ladder
 * (buffering, and asking for the bytes again), and the retry's request is
 * then held until the test lets go. A plain hold of the FIRST request would
 * show nothing at all - a song's first load calls play() only once `canplay`
 * has fired, so with no bytes there is no `waiting`, no buffering, and a
 * still disc; that is the deck's own rule and not this test's business.
 *
 * The rate is read the way the screen shows it: the face's computed
 * transform, sampled once per animation frame and unwrapped into degrees per
 * second. The assertion is a RATIO of the spooling rate to the playing rate,
 * both measured the same way on the same machine, so a slow runner changes
 * neither side alone.
 */
import { expect, test } from './fixtures/hub.ts';
import { DEVICE, audioState, nowPlaying, openLibrary, pauseHere, soloDeck } from './fixtures/deck.ts';
import type { Locator } from '@playwright/test';

/* Signed in as kim on kim's one device, like the deck suite, and off Connect
 * entirely: see DEVICE and soloDeck in fixtures/deck.ts. */
test.use({ afmUser: 'kim' });

/** The disc's own free-running pace, one revolution every six seconds. The
 *  playing rate is measured rather than assumed; this only bounds the poll
 *  that waits for the coast to finish. */
const PLAYING_DEG_PER_SEC = 60;

/**
 * The face's mean rate over `ms`, in degrees per second. The disc writes its
 * transform once per frame, so a frame is the finest thing there is to read;
 * the seam at 180 is unwrapped so a fast turn is not read as a reverse.
 */
async function rateOf(face: Locator, ms: number): Promise<number> {
  return face.evaluate(
    (el, ms) =>
      new Promise<number>((resolve) => {
        const angle = () => {
          const m = getComputedStyle(el).transform;
          if (!m || m === 'none') return 0;
          const [a, b] = m.slice(7, -1).split(',').map(Number);
          return (Math.atan2(b!, a!) * 180) / Math.PI;
        };
        let last = angle();
        let turned = 0;
        const t0 = performance.now();
        const step = () => {
          const now = angle();
          let d = now - last;
          if (d > 180) d -= 360;
          if (d < -180) d += 360;
          turned += d;
          last = now;
          const t = performance.now() - t0;
          if (t >= ms) resolve(turned / (t / 1000));
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
    ms,
  );
}

test('the disc spools several times faster while the stream is held, then coasts back', async ({ page, world }) => {
  await soloDeck(page, world);

  // The first request for the song dies on the wire; every one after waits
  // here until released. The deck reads the death as a network error on a
  // remote track, says buffering, and asks again - and that retry is the
  // request under our thumb.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route(/\/api\/stream\//, async (route) => {
    if (first) {
      first = false;
      await route.abort('failed');
      return;
    }
    await held;
    await route.continue();
  });

  await openLibrary(page, DEVICE.kim);
  await page.getByRole('button', { name: 'Play', exact: true }).click();

  // The platter is decorative to assistive tech (aria-hidden, no role), so
  // the class is the only handle there is. Its face carries the transform.
  const face = nowPlaying(page).locator('.spinningDisc__face');
  await expect(face).toBeVisible();

  // Nothing has flowed: the hold is doing its job.
  expect((await audioState(page)).every((a) => a.at === 0)).toBe(true);

  // Past the spin-up and running at the spool rate. The poll's own timeout
  // covers the ladder's first backoff (400ms) and the disc's ramp.
  await expect.poll(() => rateOf(face, 200), { timeout: 10_000 }).toBeGreaterThan(3 * PLAYING_DEG_PER_SEC);
  const spooling = await rateOf(face, 1_000);

  release();
  await expect
    .poll(async () => (await audioState(page)).some((a) => !a.paused && a.at > 0), { timeout: 20_000 })
    .toBe(true);

  // The coast: back to playing speed, and only then is the playing rate read.
  await expect.poll(() => rateOf(face, 300), { timeout: 10_000 }).toBeLessThan(1.15 * PLAYING_DEG_PER_SEC);
  const playing = await rateOf(face, 1_000);

  // The numbers themselves, kept with the run: a pass says "in the band",
  // and the band is wide enough that where in it matters when tuning.
  await test.info().attach('disc-rates', {
    body: JSON.stringify({ spoolingDegPerSec: spooling, playingDegPerSec: playing, ratio: spooling / playing }),
    contentType: 'application/json',
  });

  // Several times, not slightly: the band the spool rate lives in.
  expect(playing).toBeGreaterThan(0);
  expect(spooling / playing).toBeGreaterThanOrEqual(4);
  expect(spooling / playing).toBeLessThanOrEqual(6.5);

  await pauseHere(page);
});
