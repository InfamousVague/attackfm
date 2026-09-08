/**
 * The fixtures every suite starts from.
 *
 * Import `test` and `expect` from here, never from `@playwright/test` directly
 * - the base `test` has no idea where the app is, because the app's port is
 * decided at run time and a config file is evaluated before global-setup runs.
 * `baseURL` and `storageState` are therefore overridden as FIXTURES, which is
 * the one place they can be read from the world global-setup stood up.
 *
 * The default is signed in as `matt`, the hub's admin. A suite that wants
 * somebody else says so:
 *
 *     test.use({ afmUser: 'kim' });
 *
 * and a suite that wants two people at once opens the second context itself:
 *
 *     const kim = await contextAs(browser, world, 'kim');
 *     const page = await kim.newPage();
 *
 * A suite that is ABOUT signing in starts from nothing:
 *
 *     test.use({ storageState: { cookies: [], origins: [] } });
 *
 * or, for one context inside an otherwise signed-in file, `cleanContext`.
 * Note that `browser.newContext()` alone is NOT signed out - see there.
 */
import { test as base, expect, type Browser, type BrowserContext } from '@playwright/test';
import { readWorld, type World, type WorldUser } from './world.ts';

export { expect };
export type { World, WorldUser };

/** A thin client for the hub's own API, bound to one account's bearer. */
export class HubApi {
  constructor(
    readonly base: string,
    readonly token: string,
  ) {}

  async request(path: string, init: { method?: string; body?: unknown } = {}): Promise<unknown> {
    const reply = await fetch(`${this.base}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.token}`,
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const text = await reply.text();
    if (!reply.ok) throw new Error(`${init.method ?? 'GET'} ${path} -> ${reply.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }

  get<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request(path) as Promise<T>;
  }

  post<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    return this.request(path, { method: 'POST', body }) as Promise<T>;
  }

  put<T = Record<string, unknown>>(path: string, body?: unknown): Promise<T> {
    return this.request(path, { method: 'PUT', body }) as Promise<T>;
  }

  delete<T = Record<string, unknown>>(path: string): Promise<T> {
    return this.request(path, { method: 'DELETE' }) as Promise<T>;
  }

  /** Every track the hub holds, in index order. Handy for `id` lookups by title. */
  async tracks(): Promise<Array<Record<string, unknown>>> {
    const page = await this.get<{ tracks: Array<Record<string, unknown>> }>('/api/library?since=0&limit=500');
    return page.tracks ?? [];
  }
}

/**
 * A second browser, signed in as somebody else.
 *
 * Every groove, Connect and share scenario needs two. Both are on 127.0.0.1,
 * which means the hub considers them NEARBY to each other unconditionally
 * (`netaddr::same_network` is true for equal addresses) - so the nearby-groove
 * offer is deterministic and cheap here, and the *not*-nearby negative can
 * only be reached by spoofing `X-Forwarded-For`, exactly as
 * `verify-groove-nearby.sh` does.
 */
export async function contextAs(browser: Browser, world: World, username: string): Promise<BrowserContext> {
  const user = world.users[username];
  if (!user) throw new Error(`e2e: no fixture account called ${username}`);
  return browser.newContext({ storageState: user.statePath, baseURL: world.appUrl });
}

/**
 * A browser that has never signed in - for the suites that are ABOUT the door.
 *
 * `browser.newContext()` on its own is NOT this. Playwright hands a context
 * created inside a test the same options the test is using, so a bare
 * `newContext({ baseURL })` inherits the signed-in storageState and lands
 * straight in the library - measured, and it reads exactly like the app
 * refusing to sign out. The empty state has to be passed explicitly.
 */
export async function cleanContext(browser: Browser, world: World): Promise<BrowserContext> {
  return browser.newContext({ baseURL: world.appUrl, storageState: { cookies: [], origins: [] } });
}

/**
 * The app's own cadences, measured, in milliseconds.
 *
 * Waits are built out of these rather than out of round numbers, and NEVER out
 * of a bare `page.waitForTimeout` - an assertion with a generous timeout
 * passes as soon as the thing happens, where a sleep always costs its full
 * length and still races on a slow machine.
 *
 * Anything that needs HANDOFF or HEARTBEAT belongs in the `slow` project;
 * those two alone would add a minute and a half to every run.
 */
export const BEAT = {
  /** The host posts its state this often. */
  HOST: 2_500,
  /** A follower polls: in the room, with the tab hidden, and idle. */
  POLL_ROOM: 3_000,
  POLL_HIDDEN: 8_000,
  POLL_IDLE: 30_000,
  /** A member with no heartbeat this long is dropped. */
  HEARTBEAT_DROP: 60_000,
  /** A host quiet this long loses the clock to a follower. */
  HANDOFF: 30_000,
  /** A command older than this is not applied. */
  COMMAND_STALE: 15_000,
  /** How long a control press stays optimistically applied. */
  OPTIMISM: 8_000,
  /** The groove deck arms this long after a join. */
  DECK_ARM: 5_000,
  /** Now Playing knocks this long after a join. */
  KNOCK: 5_000,
  /** A follower more than this far off the host's clock is corrected. */
  DRIFT: 1_500,
} as const;

/** A timeout with room for one missed beat, for `expect(...).toPass` and friends. */
export const settle = (beats = 3): number => Math.round(BEAT.HOST * beats + 2_000);

interface AfmOptions {
  /** Which fixture account this file's tests are signed in as. */
  afmUser: string;
  /**
   * Whether this file's pages talk to the hub's Connect socket.
   *
   * OFF by default, and that default is the expensive lesson of Phase 4b.
   * The seat is per ACCOUNT and lives in the hub's memory for the whole run:
   * a context that plays something and then closes stays the active device
   * for the heartbeat window, because closing a browser tells the hub
   * nothing. The next context boots as a REMOTE - it mirrors a song nobody is
   * playing, `deckOwned` is false so the docked pane never appears, and a
   * press on Play is sent to a browser that no longer exists. Nothing on
   * screen says so, and the control-optimism window does not fall back.
   *
   * Two agents writing suites in parallel each lost hours to it, and each
   * arrived at the same answer: answer the socket and say nothing. So it is
   * the default here, once, rather than a beforeEach in twelve files. A suite
   * that IS about Connect opts back in:
   *
   *     test.use({ connectLive: true });
   *
   * and takes on the job of leaving the seat clean for whoever runs next.
   */
  connectLive: boolean;
}

interface AfmFixtures {
  /** The hub's API, as `afmUser`. */
  hub: HubApi;
}

interface AfmWorkerFixtures {
  world: World;
}

export const test = base.extend<AfmOptions & AfmFixtures, AfmWorkerFixtures>({
  world: [
    // eslint-disable-next-line no-empty-pattern -- Playwright's fixture signature; the destructure has to be there.
    async ({}, use) => {
      await use(readWorld());
    },
    { scope: 'worker' },
  ],

  afmUser: ['matt', { option: true }],

  connectLive: [false, { option: true }],

  /*
   * The socket, stubbed for every file that has not asked for it. It is an
   * auto fixture so a spec gets the isolation without importing anything -
   * the failure it prevents is silent, and a protection you have to remember
   * is one somebody forgets on the day it matters.
   */
  page: async ({ page, connectLive }, use) => {
    if (!connectLive) await page.routeWebSocket(/\/api\/connect/, () => {});
    await use(page);
  },

  // The app's port is not known until global-setup has picked one, and a
  // config is read before that - so this is a fixture, not a config value.
  baseURL: async ({ world }, use) => {
    await use(world.appUrl);
  },

  // Signed in before first paint. See global-setup's storageStateFor.
  storageState: async ({ world, afmUser }, use) => {
    const user = world.users[afmUser];
    if (!user) throw new Error(`e2e: no fixture account called ${afmUser}`);
    await use(user.statePath);
  },

  hub: async ({ world, afmUser }, use) => {
    const user = world.users[afmUser];
    if (!user) throw new Error(`e2e: no fixture account called ${afmUser}`);
    await use(new HubApi(world.hubUrl, user.token));
  },
});
