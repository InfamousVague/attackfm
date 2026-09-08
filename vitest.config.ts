import { mergeConfig, defineConfig } from 'vitest/config';
import appConfig from './vite.config.ts';

/**
 * The unit-test harness.
 *
 * A SEPARATE FILE, not a `test` block bolted onto `vite.config.ts`, for two
 * reasons. `vite.config.ts` is 72 lines of which 45 are the explanation of why
 * the OTA build inlines everything - it reads as a specification and a test
 * block in the middle of it reads as noise. And this repo has several sessions
 * landing work on the same tree at once: a new file conflicts with nobody,
 * while an edit to the build config conflicts with everybody.
 *
 * It MERGES the app's config rather than restating it. That is not tidiness -
 * `define` is the load-bearing part. `__AFM_VERSION__` and
 * `__AFM_UPDATES_ENABLED__` are compile-time constants, and a module that
 * mentions one (`core/version.ts`, `settings/appUpdate.ts`) throws
 * ReferenceError the moment a test imports it unless the same `define` is in
 * force here. Merging keeps one source of truth for them, and picks up the
 * React plugin at the same time so `.tsx` transforms identically in a test and
 * in the app.
 */
export default mergeConfig(
  appConfig,
  defineConfig({
    test: {
      /* The app is a browser app: `window`, `document`, `localStorage` and
         `IndexedDB` are not optional extras here, they are most of what the
         modules under test talk to. */
      environment: 'jsdom',

      /**
       * GLOBALS ARE OFF, and every test file imports what it uses:
       *
       *   import { describe, it, expect, vi } from 'vitest';
       *
       * Two reasons, one of them mechanical. `tsconfig.json` sets
       * `types: ["vite/client"]`; switching globals on would mean adding
       * `"vitest/globals"` to that array, and `tsconfig.json` is a file other
       * sessions are editing this week. Explicit imports need no ambient
       * types at all, so the harness lands without touching it. The other
       * reason is that this codebase already imports everything it uses; a
       * test file that suddenly reads from thin air would be the only file in
       * the tree that does.
       */
      globals: false,

      setupFiles: ['./src/test/setup.ts'],

      /* Co-located beside the module under test - `owned.test.ts` next to
         `owned.ts`. That is what keeps six agents writing tests in parallel on
         disjoint file sets, and it is the only arrangement where moving a
         module moves its tests with it. */
      include: ['src/**/*.test.{ts,tsx}'],

      /* A spy left installed by one test is a failure reported against the
         next one. Undo them between tests rather than trusting 400 test files
         to remember. */
      restoreMocks: true,

      coverage: {
        provider: 'v8',
        /* `text` for the person who just ran it, `lcovonly` for anything that
           wants to draw it later (CI annotations, an editor gutter).

           `lcovonly`, NOT `lcov`. Istanbul's `lcov` reporter is a bundle -
           lcovonly PLUS a full HTML site - and that site ships three
           third-party scripts (prettify, sorter, block-navigation) which
           `eslint .` then walks into and reports on. Nobody opens the HTML
           from a terminal, and the lint gate should not be reporting on
           vendored report furniture. */
        reporter: ['text', 'lcovonly'],
        reportsDirectory: './coverage',

        /* The DENOMINATOR IS THE WHOLE CLIENT, deliberately. Scoping coverage
           to "the modules that have tests" would give a flattering number that
           can FALL when someone adds the first, partial test for a new module
           - which is the one thing a ratchet must never do. Measured against
           all of `src/`, every test anyone writes can only push the number up,
           so six agents landing suites in parallel can never trip each other's
           gate. */
        include: ['src/**/*.{ts,tsx}'],
        exclude: [
          'src/**/*.test.{ts,tsx}',
          'src/test/**',
          'src/**/*.d.ts',
          /* Entry points: they wire the app together and run once. There is
             no assertion to make about them that is not an E2E assertion. */
          'src/main.tsx',
          'src/landing/**',
        ],

        /**
         * THE RATCHET.
         *
         * These are the numbers this tree actually produced on the run that
         * installed them, floored to two decimals - not a target, not a round
         * number someone liked. The rule is only that they never go down. A
         * threshold nobody can reach is a gate everyone disables; a threshold
         * set at today's truth is a gate that catches the commit which quietly
         * deletes a test.
         *
         * Phase 2 raises these once the six suites have landed, and Phase 5
         * wires them to CI. Do NOT raise them by hand mid-phase: while other
         * agents are still committing, a number set from your own working tree
         * is a number nobody else can meet yet.
         */
        thresholds: {
          // 8/24469 lines, 1/7352 functions, on the run that installed them.
          lines: 0.03,
          statements: 0.03,
          functions: 0.01,
          branches: 0.02,
        },
      },
    },
  }),
);
