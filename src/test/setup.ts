/**
 * What every test file gets for free.
 *
 * Loaded by `vitest.config.ts` as `setupFiles`, so it runs once per test FILE
 * (each file is its own module registry and its own jsdom window - two files
 * cannot leak state into one another, only two tests inside one file can).
 * Everything here exists to close one of those within-file leaks, or to give
 * jsdom a browser API it does not ship.
 *
 * `globals: false`, so nothing here puts `describe`/`it`/`expect` in scope.
 * Test files import them from 'vitest' themselves.
 */
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/**
 * The DOM matchers - `toBeInTheDocument`, `toHaveAccessibleName`,
 * `toBeDisabled` and the rest.
 *
 * The `/vitest` entry point, not the bare package: it registers the matchers
 * against Vitest's `expect` (the bare one reaches for Jest's and finds
 * nothing) and it carries the type augmentation, which `tsc` picks up because
 * `tsconfig.json` includes all of `src/` and this file lives in it. That is
 * the whole reason the setup file is under `src/test/` rather than a
 * top-level `test/`: outside `src/` the matchers would work at runtime and be
 * unknown to the type-checker.
 */
import '@testing-library/jest-dom/vitest';

/**
 * Unmount whatever the last test rendered.
 *
 * Testing Library normally installs this itself - but ONLY when it can see a
 * global `afterEach`, and this harness runs with `globals: false`, so it
 * cannot. Without this, a second `render()` in the same file finds the first
 * component still mounted and `getByRole` throws "found multiple elements",
 * which reads like a bug in the component rather than a bug in the harness.
 */
afterEach(() => {
  cleanup();
});

/**
 * An empty `localStorage` per test.
 *
 * jsdom implements the real thing, so there is nothing to stub - but it is
 * one object shared by every test in a file, and this app keeps a great deal
 * in it: sessions, prefs, the recents lists, the cache ledger. A test that
 * writes a session and a test that asserts on a signed-out app must not have
 * to be written in the right order.
 *
 * `sessionStorage` too, on the same reasoning. IndexedDB is absent from jsdom
 * entirely; a suite that needs it brings its own fake.
 */
afterEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

/**
 * `matchMedia`, which jsdom does not implement at all.
 *
 * This matters more than it looks. Twenty-one call sites in `src/` reach for
 * it, and nearly all of them are written defensively - `window.matchMedia?.(
 * '(pointer: coarse)')` - so with no implementation they do not crash, they
 * silently take the "no" branch. `useNarrowViewport` reports a wide screen
 * forever, `prefersDark` reports light, `platform.ts` decides the machine has
 * a mouse. Tests would pass while measuring a device nobody owns.
 *
 * So the default is an honest one: every query answers NO, and listeners are
 * accepted and never called. A suite for which the query IS the subject
 * should replace this with its own - `vi.stubGlobal('matchMedia', ...)`, undone
 * automatically by `restoreMocks`.
 */
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList;
}
