/**
 * A pasted PLAYLIST link becomes a playlist page you are taken to.
 *
 * Importing a playlist used to put a card in the download queue and nothing
 * else: minutes of downloading with no page to watch, and the list appearing
 * at the end. The hub now stages the list the moment it reads the listing -
 * the source's name, one want per song - and hands back its id; the app takes
 * you there, and each row says where its song is.
 *
 * What this harness can and cannot stand up, said plainly. The downloader is
 * an external tool the test hub does not have, so the IMPORT QUEUE is stubbed
 * (`/api/imports`, the one thing only a downloader could make true). The
 * playlist and its wants are REAL, made on the hub through its own routes,
 * standing in for what the hub's staging writes (which has cargo tests of its
 * own). And the importer is the REAL built plugin bundle from dist-plugins,
 * installed through the marketplace - so the second scenario can also hold
 * the line that matters for shipping it: a plugin published with the hub
 * must still load on an app from before the seam it uses existed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Locator, Page, Route } from '@playwright/test';
import { expect, test } from './fixtures/hub.ts';
import { PluginRepo, STUB_HOST, installedPlugins, serveRepos, type StubListing } from './fixtures/pluginRepo.ts';
import { sweepPlaylists } from './fixtures/playlists.ts';

const MINE = 'E2E-I ';
const LINK = 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M';

/** The importer as the builder published it: bytes and the listing it wrote. */
function realImporter(): { listing: StubListing & Record<string, unknown>; code: string } {
  const dir = join(process.cwd(), 'dist-plugins');
  const manifest = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as {
    plugins: Array<StubListing & Record<string, unknown>>;
  };
  const listing = manifest.plugins.find((p) => p.id === 'spotify-import');
  if (!listing) throw new Error('e2e: dist-plugins has no spotify-import - run node scripts/build-plugins.mjs');
  return { listing, code: readFileSync(join(dir, listing.entry), 'utf8') };
}

async function openPlugins(page: Page): Promise<Locator> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Settings' }).click();
  const modal = page.getByRole('dialog').filter({ has: page.getByRole('tablist') });
  await expect(modal).toBeVisible();
  await modal.getByRole('tab', { name: /^Plugins\b/ }).click();
  await expect(modal.getByText('Available', { exact: true })).toBeVisible();
  return modal;
}

/** Add the stub repository and install the importer off it, the way a person does. */
async function installImporter(page: Page): Promise<void> {
  const modal = await openPlugins(page);
  const view = modal.getByRole('radiogroup', { name: 'Plugins view' });
  await view.getByText('Sources', { exact: true }).click();
  await modal.getByRole('textbox', { name: 'Repository address' }).fill(STUB_HOST);
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByRole('button', { name: 'Add repository' }).click();
  await view.getByText('Browse', { exact: true }).click();
  await modal.getByRole('button', { name: 'Install' }).click();
  await expect.poll(() => installedPlugins(page)).toEqual([
    expect.objectContaining({ id: 'spotify-import', version: '1.7.0' }),
  ]);
  // Installing mounts the importer's own Settings pane, which re-lays the
  // modal out on its first pane - so what proves the plugin LOADED is what it
  // does, below, not a switch that has scrolled out of the modal's view.
  await page.getByRole('button', { name: 'Close' }).first().click();
  await expect(modal).toHaveCount(0);
}

/**
 * Paste a link into search and import it, where a person does.
 *
 * On this viewport Search is the summoned palette, and a link there offers the
 * importer's own command - "Import to library" - which is the path that runs
 * through the plugin (and through its lookup of the landing seam). Its
 * presence is also the first proof the plugin loaded at all.
 */
async function importFromSearch(page: Page, link: string): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary' }).getByRole('button', { name: 'Search' }).click();
  await page.getByRole('combobox', { name: 'Search' }).fill(link);
  const command = page.getByText('Import to library', { exact: true });
  await expect(command).toBeVisible();
  await command.click();
}

test.afterEach(async ({ hub }) => {
  await sweepPlaylists(hub, MINE);
});

test('a pasted playlist link takes you to its playlist, and each song says where it is', async ({ page, hub }) => {
  const crashes: string[] = [];
  page.on('pageerror', (e) => crashes.push(e.message));

  // What the hub's staging makes: the list, and a want per song.
  const name = `${MINE}Road Trip`;
  const made = await hub.post<{ id: number }>('/api/playlists', { name, tracks: [] });
  await hub.post(`/api/playlists/${made.id}/wants`, { artist: 'Nobody Here', title: 'First Mile', url: '' });
  await hub.post(`/api/playlists/${made.id}/wants`, { artist: 'Nobody Here', title: 'Second Mile', url: '' });

  // The queue the downloader would keep: this link, downloading its first song.
  const job = {
    id: 'e2e-import-1',
    url: LINK,
    kind: 'playlist',
    title: name,
    service: 'spotify',
    quality: 'lossless',
    total: 2,
    completed: 0,
    skipped: 0,
    state: 'downloading',
    error: null,
    createdAt: Date.now(),
    artworkUrl: null,
    subtitle: null,
    currentTrack: 'First Mile',
    tracks: ['First Mile', 'Second Mile'],
    items: [
      { title: 'First Mile', artist: 'Nobody Here' },
      { title: 'Second Mile', artist: 'Nobody Here' },
    ],
    currentIndex: 0,
    outputDir: '',
    files: [],
    trackIds: [],
    playlistId: made.id,
  };
  let enqueued = 0;
  await page.route(/\/api\/imports(\?.*)?$/, (route: Route) => {
    if (route.request().method() === 'POST') {
      enqueued += 1;
      return route.fulfill({ json: job });
    }
    return route.fulfill({ json: { jobs: enqueued > 0 ? [job] : [] } });
  });

  const repo = new PluginRepo();
  const importer = realImporter();
  repo.publishBundle(importer.listing, importer.code);
  await serveRepos(page, repo);

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await installImporter(page);

  await importFromSearch(page, LINK);
  await expect.poll(() => enqueued, { timeout: 10_000 }).toBeGreaterThan(0);

  // Taken to the list the hub made - not left on the search, not the Downloads pane.
  await expect(page.getByRole('heading', { name })).toBeVisible({ timeout: 20_000 });
  const first = page.getByRole('row', { name: /First Mile/ });
  const second = page.getByRole('row', { name: /Second Mile/ });
  await expect(first).toContainText('downloading');
  await expect(second).toContainText('waiting for its turn');

  // The run moves on: a finished song reads as downloaded while the hub files
  // it (a want the hub gave up on reads from the hub's own mark, which the
  // wantProgress unit tests cover).
  job.state = 'done';
  job.completed = 2;
  job.currentIndex = null as unknown as number;
  await expect(first).toContainText('downloaded', { timeout: 20_000 });

  expect(crashes).toEqual([]);
});

test('the importer published with the hub still loads on an app without the landing seam', async ({ page }) => {
  /*
   * The plugin is republished on every hub deploy, and a device keeps running
   * whatever app it has until it updates - a native build can be weeks behind.
   * A bundle's host imports are resolved when it loads, and a missing one
   * THROWS, which would take the whole importer off every older device the
   * moment the hub deployed. So the plugin looks the seam up when it runs
   * instead of importing it. Simulated here by taking the seam out of the
   * host table as the app installs it.
   */
  const crashes: string[] = [];
  page.on('pageerror', (e) => crashes.push(e.message));
  await page.addInitScript(() => {
    let held: { modules?: Record<string, unknown> } | undefined;
    Object.defineProperty(globalThis, '__ATTACKFM_HOST__', {
      configurable: true,
      get: () => held,
      set: (value: { modules?: Record<string, unknown> }) => {
        if (value?.modules) delete value.modules['@attackfm/app/importLanding'];
        held = value;
      },
    });
  });
  let enqueued = 0;
  await page.route(/\/api\/imports(\?.*)?$/, (route: Route) => {
    if (route.request().method() === 'POST') {
      enqueued += 1;
      return route.fulfill({ json: { id: 'e2e-old-app', url: LINK, kind: 'playlist', title: '', service: 'spotify', quality: 'lossless', total: null, completed: 0, state: 'queued', error: null, createdAt: Date.now(), artworkUrl: null, subtitle: null, currentTrack: null, tracks: [], currentIndex: null, outputDir: '', files: [] } });
    }
    return route.fulfill({ json: { jobs: [] } });
  });
  const repo = new PluginRepo();
  const importer = realImporter();
  repo.publishBundle(importer.listing, importer.code);
  await serveRepos(page, repo);

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  const seamGone = await page.evaluate(
    () =>
      !((globalThis as { __ATTACKFM_HOST__?: { modules?: Record<string, unknown> } }).__ATTACKFM_HOST__?.modules ?? {})[
        '@attackfm/app/importLanding'
      ],
  );
  expect(seamGone, 'the simulation must actually remove the seam').toBe(true);

  await installImporter(page);
  // LOADED, proven by what it does: its command is offered for a pasted link,
  // and running it - which now looks for the seam and finds nothing - still
  // reaches the queue rather than throwing.
  await importFromSearch(page, LINK);
  await expect.poll(() => enqueued, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(crashes.filter((m) => /host module missing|importLanding/.test(m))).toEqual([]);
});
