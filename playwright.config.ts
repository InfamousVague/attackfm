/**
 * Playwright, against a real hub and a real registry.
 *
 * TWO PROJECTS, on purpose. Most of what the suites assert settles inside a
 * few of the host's 2.5 s beats; a handful of scenarios wait on the 30 s
 * hand-off or the 60 s heartbeat drop. Putting those in the same project would
 * make every run pay for them, so `fast` is what anyone runs while working and
 * `slow` is what CI adds. A spec opts into `slow` by tagging its tests
 * `@slow`; nothing else changes.
 *
 * Chromium only. The app ships inside a WKWebView and an Android WebView; the
 * WebKit-specific behaviour this repo has been bitten by (an interrupted
 * AudioContext, aspect-ratio inside a flex column, WAAPI on SVG geometry) does
 * not reproduce in Playwright's WebKit build anyway, and it is caught on a
 * real device. Firefox would add flake without adding signal.
 *
 * `baseURL` and `storageState` are deliberately NOT set here: the app's port
 * is chosen by global-setup, which runs after this file is read. They are
 * fixtures instead - see e2e/fixtures/hub.ts.
 */
import { defineConfig, devices } from '@playwright/test';

const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  // A spec's own timeout. The hub is real and the first paint of a 3.7 MB
  // bundle is not instant, so this is not the default 30 s.
  timeout: 60_000,
  expect: { timeout: 10_000 },

  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',

  // One hub, one library, one set of accounts. Suites that write to the hub
  // (a playlist, a like, a groove room) would see each other's writes if they
  // ran at once, and "passes alone, fails in a run" is the most expensive kind
  // of flake there is. Concurrency is a decision for later, per suite, once
  // the suites exist and their write sets are known.
  workers: 1,
  fullyParallel: false,

  // Never in CI: a retry that goes green hides a race that will come back.
  // Locally a retry is a convenience; here it would let a flaky suite land.
  retries: 0,
  forbidOnly: CI,

  reporter: CI ? [['github'], ['list']] : [['list']],

  use: {
    ...devices['Desktop Chrome'],
    trace: 'retain-on-failure',
    video: 'off',
    screenshot: 'only-on-failure',
    launchOptions: {
      args: [
        // The app plays audio. A click is a user gesture and would satisfy
        // the autoplay policy on its own, but a test that starts playback
        // any other way (a deep link, a groove join, a queue advance) would
        // silently never start without this.
        '--autoplay-policy=no-user-gesture-required',
        // The fixture library is silence, but a developer running this on
        // their own machine should not have to find out the hard way.
        '--mute-audio',
      ],
    },
  },

  projects: [
    {
      name: 'fast',
      // Everything except the long-window scenarios.
      grepInvert: /@slow/,
    },
    {
      name: 'slow',
      grep: /@slow/,
      // A 60 s heartbeat drop plus the setup around it does not fit in 60 s.
      timeout: 180_000,
    },
  ],
});
