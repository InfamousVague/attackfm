/**
 * A plugin repository, stood up inside the browser.
 *
 * A repository is nothing but a URL serving `index.json` and, beside it, one
 * bundle file per plugin version (`src/plugins/remote.ts`). Neither half needs
 * a server to exist: `page.route` can be the whole repository, which is what
 * this is - and it makes the repository MUTABLE, which is the point. The
 * scenario §7 asks for is "install 1.0.0, publish 1.1.0, relaunch, be on
 * 1.1.0", and that cannot be written against a static folder on disk.
 *
 * THE BUNDLE SHAPE IS A CONTRACT, and it is copied from the real builder
 * (`scripts/build-plugins.mjs`) rather than invented here:
 *
 *  - esbuild is asked for `format: 'iife'` with `globalName:
 *    'AttackFMPluginExport'`, so a bundle is `var AttackFMPluginExport =
 *    (() => { ... })();` and nothing else. The app's evaluator runs it as
 *    `new Function('"use strict";' + code + ';return AttackFMPluginExport;')`,
 *    so the name has to be a plain `var` at the top of that scope.
 *  - the exported object has ONE member the host looks for, `createPlugin`,
 *    and it is handed the host: `factory.createPlugin(host)`.
 *  - every import a plugin's source made - `react`, `@glacier/react`, the
 *    `@attackfm/app/*` seam - was compiled by that builder into a lookup in
 *    `globalThis.__ATTACKFM_HOST__.modules[...]`, because a plugin may never
 *    bring its own React. The bundles below reach for the same table through
 *    the `host` they are given, which is the same object.
 *
 * A stub built from a guess would test the stub. These are built from the
 * builder, so a change to the contract breaks this file - which is the
 * correct place for it to break.
 */
import type { Page, Route } from '@playwright/test';

/**
 * The stub's address.
 *
 * Typed into the Add box WITHOUT a scheme, exactly as somebody would type it -
 * `normalizeSourceUrl` (which is `normalizeServerUrl`, shared with the server
 * door) assumes TLS for a bare host, so this is what it becomes. `.test` is
 * reserved by RFC 6761 and can never resolve, so a route that fails to
 * intercept fails loudly rather than reaching somebody's real server.
 */
export const STUB_HOST = 'plugins.test';
export const STUB_SOURCE = `https://${STUB_HOST}`;

/**
 * The repository the app ships pointing at.
 *
 * It is in `DEFAULT_SOURCES`, so every boot fetches it and `ensureDefaultPlugins`
 * tries to install `audible` off it. Left alone, every plugins test would depend
 * on a live server on the internet and on whatever it happens to be publishing
 * today. Stubbed empty instead - see `serveRepos`.
 */
export const OFFICIAL_SOURCE = 'https://plugins.attack.fm';

/** What the app's own builder stamps into every listing it publishes. */
export const HOST_API = 1;

/** One plugin as a manifest lists it - the shape of `RemotePluginListing`. */
export interface StubListing {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  tags?: string[];
  entry: string;
  api: number;
  desktopOnly?: boolean;
  serverBacked?: boolean;
  requiresServer?: boolean;
}

/** What a stub plugin does once it is running. */
export interface StubSpec {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  tags?: string[];
  /** Declared API level. Above the host's and the install must be refused. */
  api?: number;
  /** Adds a navigable page with this nav label. */
  page?: { id: string; label: string; /** Drawn in the content area. */ body: string };
  /**
   * Adds a component to one of the chrome's fixed mount points.
   *
   * `player-trailing` is the one a desktop actually renders (the strip's
   * trailing cluster); `titlebar-end` is still in the type and has no mount
   * point left in the app, so a plugin declaring it draws nothing anywhere.
   */
  slot?: { id: 'player-trailing' | 'now-playing-actions'; label: string };
  /**
   * The page throws instead of rendering.
   *
   * This is the whole point of the error boundary: a plugin that throws is
   * meant to be PULLED, not to take the app with it. A bundle that merely
   * fails to evaluate would exercise a different (and much easier) path -
   * `installPlugin` refuses that one before it is ever persisted.
   */
  crashOnRender?: boolean;
  desktopOnly?: boolean;
  serverBacked?: boolean;
  requiresServer?: boolean;
}

/**
 * One publishable bundle, as the builder would emit it.
 *
 * Deliberately hand-written ES5-ish: it is evaluated by `new Function` under
 * `"use strict"` with no transpiler anywhere near it, and a syntax error here
 * would read in the app as "this plugin is not an AttackFM plugin bundle".
 */
export function bundleFor(spec: StubSpec): string {
  const page = spec.page;
  const content = spec.crashOnRender
    ? `function Content() { throw new Error(${JSON.stringify(`${spec.name} fell over`)}); }`
    : `function Content() {
         return React.createElement(
           'div',
           { className: 'stubPluginPage' },
           React.createElement('h2', null, ${JSON.stringify(page?.label ?? spec.name)}),
           React.createElement('p', null, ${JSON.stringify(page?.body ?? '')}),
           React.createElement('p', null, 'v' + ${JSON.stringify(spec.version)})
         );
       }`;

  const pages = page
    ? `pages: [{
         id: ${JSON.stringify(page.id)},
         label: ${JSON.stringify(page.label)},
         icon: React.createElement('span', { 'aria-hidden': 'true' }, '\\u25C6'),
         Content: Content
       }],`
    : '';

  const slots = spec.slot
    ? `slots: { ${JSON.stringify(spec.slot.id)}: function Slot() {
         return React.createElement(
           'button',
           { type: 'button', 'aria-label': ${JSON.stringify(spec.slot.label)} },
           '\\u25C6'
         );
       } },`
    : '';

  return `var AttackFMPluginExport = (function () {
  function createPlugin(host) {
    var React = host.modules['react'];
    ${content}
    return {
      id: ${JSON.stringify(spec.id)},
      name: ${JSON.stringify(spec.name)},
      description: ${JSON.stringify(spec.description ?? `${spec.name}, from a repository.`)},
      details: ${JSON.stringify(`${spec.name} was installed from a plugin repository.`)},
      author: ${JSON.stringify(spec.author ?? 'E2E')},
      version: ${JSON.stringify(spec.version)},
      tags: ${JSON.stringify(spec.tags ?? ['Test'])},
      icon: React.createElement('span', { 'aria-hidden': 'true' }, '\\u25C6'),
      ${pages}
      ${slots}
      ${spec.desktopOnly ? 'desktopOnly: true,' : ''}
      ${spec.serverBacked ? 'serverBacked: true,' : ''}
      ${spec.requiresServer ? 'requiresServer: true,' : ''}
    };
  }
  return { createPlugin: createPlugin };
})();`;
}

/** The bundle filename the builder would give this version. */
export function entryFor(spec: StubSpec): string {
  return `${spec.id}-${spec.version}.js`;
}

/**
 * A repository whose catalogue can change between page loads.
 *
 * `publish` replaces a plugin's listing with a newer version and keeps the old
 * bundle reachable, exactly as a real repository does - a device that has
 * 1.0.0 installed never re-fetches it, and one that installs after the bump
 * gets 1.1.0.
 */
export class PluginRepo {
  private readonly bundles = new Map<string, string>();
  private readonly listings = new Map<string, StubListing>();
  /** Every manifest fetch this repository has answered, for "asked once" checks. */
  readonly manifestHits: number[] = [];

  constructor(readonly source: string = STUB_SOURCE) {}

  /** Add or replace a plugin. A second call with a higher version is a release. */
  publish(spec: StubSpec): StubListing {
    const entry = entryFor(spec);
    this.bundles.set(entry, bundleFor(spec));
    const listing: StubListing = {
      id: spec.id,
      name: spec.name,
      version: spec.version,
      description: spec.description ?? `${spec.name}, from a repository.`,
      author: spec.author ?? 'E2E',
      tags: spec.tags ?? ['Test'],
      entry,
      api: spec.api ?? HOST_API,
      ...(spec.desktopOnly ? { desktopOnly: true } : {}),
      ...(spec.serverBacked ? { serverBacked: true } : {}),
      ...(spec.requiresServer ? { requiresServer: true } : {}),
    };
    this.listings.set(spec.id, listing);
    return listing;
  }

  /** Take a plugin off the shelf. A repository dropping one is NOT an uninstall. */
  withdraw(id: string): void {
    this.listings.delete(id);
  }

  manifest(): { api: number; name: string; plugins: StubListing[] } {
    return { api: HOST_API, name: 'E2E plugins', plugins: [...this.listings.values()] };
  }

  /**
   * Wire this repository into one page.
   *
   * Cross-origin, so the fulfilled responses carry `access-control-allow-origin`
   * - without it the browser refuses the body and the app reports the
   * repository as unreachable, which reads exactly like a broken stub.
   */
  async serve(page: Page): Promise<void> {
    await page.route(`${this.source}/index.json`, (route: Route) => {
      this.manifestHits.push(Date.now());
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: JSON.stringify(this.manifest()),
      });
    });
    await page.route(`${this.source}/*.js`, (route: Route) => {
      const name = new URL(route.request().url()).pathname.replace(/^\//, '');
      const code = this.bundles.get(name);
      if (code === undefined) {
        return route.fulfill({
          status: 404,
          headers: { 'access-control-allow-origin': '*' },
          body: 'no such bundle',
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
        body: code,
      });
    });
  }
}

/**
 * Every repository this page may talk to, and nothing else.
 *
 * The official repository is in `DEFAULT_SOURCES` and is fetched on EVERY boot,
 * by `useRepoFeeds` for the pane and by `ensureDefaultPlugins` for the
 * `audible` default - so without this a plugins test reaches the public
 * internet twice a page load and asserts against whatever is published today.
 * It is answered with an empty catalogue instead: present, reachable,
 * offering nothing, which is the one shape that changes nothing else on the
 * page.
 */
export async function serveRepos(page: Page, ...repos: PluginRepo[]): Promise<void> {
  await page.route(`${OFFICIAL_SOURCE}/**`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' },
      body: JSON.stringify({ api: HOST_API, name: 'AttackFM plugins', plugins: [] }),
    }),
  );
  for (const repo of repos) await repo.serve(page);
}

/** What the app has persisted as installed, read the way the app reads it. */
export async function installedPlugins(
  page: Page,
): Promise<Array<{ id: string; version: string; source: string }>> {
  return page.evaluate(() => {
    try {
      const raw = localStorage.getItem('attackfm-plugins-installed');
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      return (parsed as Array<{ id: string; version: string; source: string }>).map((p) => ({
        id: p.id,
        version: p.version,
        source: p.source,
      }));
    } catch {
      return [];
    }
  });
}
