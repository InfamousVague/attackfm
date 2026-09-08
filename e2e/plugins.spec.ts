/**
 * Plugins: the marketplace, the switch, the repository, and the fence.
 *
 * A plugin is CODE the user chose to run inside the app, fetched from a URL
 * somebody else owns and evaluated by hand (`remote.ts::evaluateBundle`). Every
 * scenario here is one of the four things that has actually gone wrong with
 * that arrangement:
 *
 *  - a plugin's contribution not appearing, or not leaving, when the switch
 *    is flipped - which is the whole of what a switch means;
 *  - a bundle that throws taking the app down with it, rather than being
 *    pulled and reported (the error boundary is a FEATURE, not a safety net);
 *  - a device pinned forever on the version it first installed, with nothing
 *    in the app to say a newer one exists - the failure `ensureDefaultPlugins`
 *    grew its second half to fix;
 *  - a retired plugin living on as a second copy of a UI the app now carries
 *    itself, which is what `DEPRECATED_PLUGINS` exists to take off a device.
 *
 * The repository is a stub, in `fixtures/pluginRepo.ts`, and it is MUTABLE -
 * "publish 1.1.0 and relaunch" cannot be written against a folder on disk.
 * `serveRepos` also answers the baked-in `https://plugins.attack.fm` with an
 * empty catalogue: it is in `DEFAULT_SOURCES`, so without that every test here
 * would reach the public internet on every page load and assert against
 * whatever is published today.
 */
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures/hub.ts';
import {
  PluginRepo,
  STUB_HOST,
  STUB_SOURCE,
  installedPlugins,
  serveRepos,
} from './fixtures/pluginRepo.ts';

/**
 * ONE DEVICE, ON ITS OWN.
 *
 * Every browser context mints a fresh Connect device id, and a device that has
 * played something stays the hub's active seat long after Playwright closed
 * its context - the heartbeat drop is a minute away. A later test then boots
 * as a REMOTE: its player mirrors the dead device rather than holding a deck
 * of its own, and the docked Now Playing pane (which may only stand for THIS
 * device's deck) never appears. Which surface a plugin's slot renders into
 * would then depend on what the suite before this one happened to play.
 *
 * So the Connect socket is answered here and told nothing. Whose seat it is
 * belongs to the `connect` suite; this one is about plugins.
 */
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket(/\/api\/connect/, () => {
    // Accepted, and never spoken to.
  });
});

/** The three the build carries (`src/plugins/index.ts`), in registration order. */
const COMPILED_IN = ['Buy', 'Books', 'Visualizers'] as const;

/**
 * Settings, on the Plugins pane.
 *
 * The dialog is found by the tablist it contains, NOT by `.first()`: the Now
 * Playing sheet is a dialog too and comes first in the DOM, so once anything
 * is playing `.first()` is the player and every settings locator inside it
 * waits forever. The rail is a real tablist and its rows are real tabs, so the
 * pane is reached by role - the tab's name carries its live summary
 * ("Plugins 3 of 3 enabled"), hence the anchored prefix.
 */
async function openPlugins(page: Page): Promise<Locator> {
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Settings' })
    .click();
  const modal = page.getByRole('dialog').filter({ has: page.getByRole('tablist') });
  await expect(modal).toBeVisible();
  await modal.getByRole('tab', { name: /^Plugins\b/ }).click();
  // The marketplace's own heading, so the pane is proven open rather than
  // merely clicked at.
  await expect(modal.getByText('Available', { exact: true })).toBeVisible();
  return modal;
}

/**
 * The label around a plugin's switch - which is the only part of it a pointer
 * can reach.
 *
 * The kit builds a Switch as a native checkbox carrying `role="switch"` with
 * the track and thumb painted over it and marked `aria-hidden`, so a click on
 * the role lands on nothing and times out. Its enclosing `<label>` is what a
 * thumb hits, and clicking it is the honest gesture; `force: true` on the
 * input would also pass on a switch nobody could reach. The STATE is still
 * read off the input, because that is what a screen reader is told.
 */
function switchLabel(scope: Locator, name: string): Locator {
  return scope.getByRole('switch', { name }).locator('..');
}

/**
 * Browse / Sources.
 *
 * A SegmentedControl, which is a radiogroup whose label span lies OVER the
 * input - so `getByRole('radio', ...).click()` never lands, exactly as it does
 * not for the library's Music/Books toggle. The label is what a thumb hits, so
 * the label is what this clicks; `force: true` would also pass on a control
 * nobody could reach.
 */
function view(modal: Locator): Locator {
  return modal.getByRole('radiogroup', { name: 'Plugins view' });
}

/**
 * Add the stub repository, through the door a person uses.
 *
 * The address is typed WITHOUT a scheme, which is how anyone types one -
 * `normalizeSourceUrl` assumes TLS for a bare host. Adding a repository is
 * trusting its owner with code that runs inside the app, and the app says so
 * in an AlertDialog before it does anything; confirming it is part of the
 * scenario rather than something to route around.
 */
async function addStubSource(page: Page, modal: Locator): Promise<void> {
  await view(modal).getByText('Sources', { exact: true }).click();
  await modal.getByRole('textbox', { name: 'Repository address' }).fill(STUB_HOST);
  await modal.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Add this repository?')).toBeVisible();
  await page.getByRole('button', { name: 'Add repository' }).click();
  await view(modal).getByText('Browse', { exact: true }).click();
}

test('the pane lists every plugin the build carries, and counts the ones that are on', async ({
  page,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await serveRepos(page);

  await page.goto('/');
  const modal = await openPlugins(page);

  // Three cards, each with its own switch. The switch's name carries the
  // plugin's name, which is the only thing distinguishing three identical
  // controls to a screen reader - and to this.
  for (const name of COMPILED_IN) {
    await expect(modal.getByRole('switch', { name: `Enable ${name}` })).toBeChecked();
    await expect(modal.getByRole('button', { name: `About ${name}` })).toBeVisible();
  }

  // The count is derived from the registry, not written down beside it.
  await expect(modal.getByText('3 plugins · 3 enabled', { exact: false })).toBeVisible();

  /*
   * THE WORDS ARE WORDS, not catalogue keys.
   *
   * `buy`, `books` and `visualizers` are built at module load - before anybody
   * has chosen a language - so their name and description fields hold i18n
   * KEYS until `localizePlugins` puts the prose back at the one chokepoint
   * every consumer reads through (PluginsProvider). When that stops happening
   * the pane still renders perfectly: it just says `plugins.books.name`. A
   * card whose name looks like a dotted key is the tell.
   */
  for (const name of COMPILED_IN) {
    expect(name).not.toMatch(/\./);
    await expect(modal.getByText(name, { exact: true }).first()).toBeVisible();
  }

  expect(crashes).toEqual([]);
});

test('switching a plugin off takes its contribution out of the app, and on puts it back', async ({
  page,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));
  await serveRepos(page);

  await page.goto('/');

  /*
   * BOOKS IS THE ONE TO DO THIS WITH.
   *
   * The audiobook shelf is a plugin whose page the LIBRARY renders - the
   * Music/Books toggle at the top of the page only exists while the plugin is
   * on (`LibraryView`: `const toggle = booksPage ? ... : null`). So the
   * radiogroup's presence is a live read of `usePlugins().enabled` taken from
   * somewhere completely outside the settings pane, which is the only kind of
   * assertion that proves a switch did anything.
   */
  const sections = page.getByRole('radiogroup', { name: 'Library section' });
  await expect(sections).toBeVisible();

  const modal = await openPlugins(page);
  await switchLabel(modal, 'Enable Books').click();
  await expect(modal.getByRole('switch', { name: 'Enable Books' })).not.toBeChecked();
  await expect(modal.getByText('3 plugins · 2 enabled', { exact: false })).toBeVisible();

  // The switch is a SETTING, so it persists as one - a plain list of ids, the
  // way the favourites do.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('attackfm-plugins-disabled')))
    .toBe('["books"]');

  await page.keyboard.press('Escape');
  await expect(sections).toBeHidden();

  // And back. Either flip is also the retry for a crashed plugin, which is
  // why nothing here has to clear anything first.
  const again = await openPlugins(page);
  await switchLabel(again, 'Enable Books').click();
  await expect(again.getByRole('switch', { name: 'Enable Books' })).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(sections).toBeVisible();
  await sections.getByText('Books', { exact: true }).click();
  await expect(page.getByText('The Long Ascent').first()).toBeVisible();

  expect(crashes).toEqual([]);
});

test("a repository's plugin installs, and brings its page and its player button with it", async ({
  page,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const repo = new PluginRepo();
  repo.publish({
    id: 'wayfarer',
    name: 'Wayfarer',
    version: '1.0.0',
    description: 'A page and a button, from somebody else’s server.',
    page: { id: 'main', label: 'Wayfarer', body: 'Drawn by a bundle the app downloaded.' },
    // The slot the sheet mounts. `player-trailing` is the strip's, and on this
    // viewport the strip is display:none while Now Playing is up - so a plugin
    // living only there would be installed, enabled and invisible, which is
    // the wrong thing for a test to call a pass.
    slot: { id: 'now-playing-actions', label: 'Wayfarer control' },
  });
  await serveRepos(page, repo);

  await page.goto('/');
  const modal = await openPlugins(page);

  // Nothing on offer until a repository is listed. The official one is stubbed
  // empty, so this is the app's own "no repository is offering anything".
  await expect(modal.getByText('No repository is offering anything.', { exact: false })).toBeVisible();

  await addStubSource(page, modal);

  // The offer, as the repository describes it - name, version, blurb, and
  // where it came from.
  await expect(modal.getByText('A page and a button, from somebody else’s server.')).toBeVisible();
  await expect(modal.getByText('v1.0.0', { exact: false }).first()).toBeVisible();
  await modal.getByRole('button', { name: 'Install' }).click();

  // Installing PERSISTS the bundle, which is what makes a repository a
  // distribution channel rather than a runtime dependency.
  await expect
    .poll(() => installedPlugins(page))
    .toEqual([{ id: 'wayfarer', version: '1.0.0', source: STUB_SOURCE }]);

  // It is a card on the shelf now, beside the compiled-in three.
  await expect(modal.getByRole('switch', { name: 'Enable Wayfarer' })).toBeChecked();
  await expect(modal.getByText('4 plugins · 4 enabled', { exact: false })).toBeVisible();

  await page.keyboard.press('Escape');

  // 1. THE PAGE. A nav seat of its own, and its own destination.
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('button', { name: 'Wayfarer' })).toBeVisible();
  await nav.getByRole('button', { name: 'Wayfarer' }).click();
  await expect(page.getByRole('heading', { name: 'Wayfarer' })).toBeVisible();
  await expect(page.getByText('Drawn by a bundle the app downloaded.')).toBeVisible();

  // 2. THE SLOT. Beside the app's own controls where the song is.
  await nav.getByRole('button', { name: 'Library' }).click();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Now playing' });
  await expect(sheet.getByRole('button', { name: 'Wayfarer control' })).toBeVisible();

  // 3. AND THE SWITCH GOVERNS BOTH. A remote plugin answers to it exactly as
  //    a compiled-in one does - there is one `enabled` list, not two.
  const back = await openPlugins(page);
  await switchLabel(back, 'Enable Wayfarer').click();
  await page.keyboard.press('Escape');
  await expect(nav.getByRole('button', { name: 'Wayfarer' })).toBeHidden();
  await expect(sheet.getByRole('button', { name: 'Wayfarer control' })).toBeHidden();

  expect(crashes).toEqual([]);
});

test('a plugin that throws is pulled, and the app is still standing', async ({ page }) => {
  /*
   * The error boundary is the feature under test, so an escaped error is the
   * failure. React reports a boundary-handled throw to `console.error` and
   * NOT to window.onerror, so `pageerror` staying empty is exactly the line
   * between "the fence caught it" and "the app went down".
   */
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const repo = new PluginRepo();
  repo.publish({
    id: 'faulty',
    name: 'Faulty',
    version: '1.0.0',
    crashOnRender: true,
    page: { id: 'main', label: 'Faulty', body: '' },
  });
  await serveRepos(page, repo);

  await page.goto('/');
  const modal = await openPlugins(page);
  await addStubSource(page, modal);
  await modal.getByRole('button', { name: 'Install' }).click();
  await expect.poll(() => installedPlugins(page)).toHaveLength(1);
  await page.keyboard.press('Escape');

  // It installed and registered like any other - a bundle that merely fails to
  // EVALUATE is a different (and much easier) path, refused before it is ever
  // persisted. This one evaluates fine and then throws at render.
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('button', { name: 'Faulty' })).toBeVisible();
  await nav.getByRole('button', { name: 'Faulty' }).click();

  // The fence reports the crash, which removes the plugin from `enabled` -
  // so its seat leaves with it and the nav host falls back rather than
  // rendering a page that cannot render.
  await expect(nav.getByRole('button', { name: 'Faulty' })).toBeHidden();
  await expect(nav.getByRole('button', { name: 'Library' })).toBeVisible();

  // THE REST OF THE APP IS UNTOUCHED. Not just present - still working: the
  // library still navigates, the book is still on its shelf.
  await nav.getByRole('button', { name: 'Library' }).click();
  const sections = page.getByRole('radiogroup', { name: 'Library section' });
  await sections.getByText('Books', { exact: true }).click();
  await expect(page.getByText('The Long Ascent').first()).toBeVisible();

  // And the card says what happened, against the plugin that did it. The
  // switch stays ON - it is the user's setting, not the running state - so one
  // flip off is a decision and off-and-on is the retry.
  const after = await openPlugins(page);
  await expect(after.getByText('Crashed', { exact: true })).toBeVisible();
  await expect(after.getByRole('switch', { name: 'Enable Faulty' })).toBeChecked();

  expect(crashes).toEqual([]);
});

test('a newer version in the repository reaches a device that already has the old one', async ({
  page,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  const repo = new PluginRepo();
  const spec = {
    id: 'wayfarer',
    name: 'Wayfarer',
    page: { id: 'main', label: 'Wayfarer', body: 'A page from a repository.' },
  };
  repo.publish({ ...spec, version: '1.0.0' });
  await serveRepos(page, repo);

  await page.goto('/');
  const modal = await openPlugins(page);
  await addStubSource(page, modal);
  await modal.getByRole('button', { name: 'Install' }).click();
  await expect
    .poll(() => installedPlugins(page))
    .toEqual([{ id: 'wayfarer', version: '1.0.0', source: STUB_SOURCE }]);

  // --- 1. The offer, made where somebody will see it --------------------
  //
  // Nothing updates on its own: a plugin is code the user chose to run, so a
  // new version is an OFFER. Which is exactly why it has to be visible without
  // going looking for it.
  repo.publish({ ...spec, version: '1.1.0' });
  await view(modal).getByText('Sources', { exact: true }).click();
  await modal.getByRole('button', { name: 'Refresh' }).click();
  await view(modal).getByText('Browse', { exact: true }).click();

  await expect(modal.getByText('1 update available')).toBeVisible();
  await expect(modal.getByText('v1.0.0 → v1.1.0')).toBeVisible();
  // The row's own button rather than the banner's "Update all": with one offer
  // both carry the same word, and this is the one beside the version numbers.
  await modal.locator('.pluginUpdateRow').getByRole('button', { name: 'Update' }).click();
  await expect
    .poll(() => installedPlugins(page))
    .toEqual([{ id: 'wayfarer', version: '1.1.0', source: STUB_SOURCE }]);
  await expect(modal.getByText('1 update available')).toBeHidden();

  /*
   * --- 2. And the half that was missing ---------------------------------
   *
   * `ensureDefaultPlugins` only ever considered DEFAULT_PLUGINS, so a plugin
   * somebody installed by hand stayed on whatever version they first got,
   * forever, with nothing in the app to say a newer bundle existed - removing
   * and re-adding was the only cure and nothing anywhere said so. This is that
   * failure, run from the other end: publish, RELAUNCH, touch no UI at all.
   */
  repo.publish({ ...spec, version: '1.2.0' });
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await expect
    .poll(() => installedPlugins(page), { timeout: 20_000 })
    .toEqual([{ id: 'wayfarer', version: '1.2.0', source: STUB_SOURCE }]);

  expect(crashes).toEqual([]);
});

test('a bundle whose id has been retired is taken off the device, and never offered again', async ({
  page,
}) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  /*
   * A repository dropping a plugin is NOT an uninstall: the bundle lives in
   * this device's own storage and keeps rendering its page forever. So a
   * retired id has to be named in `DEPRECATED_PLUGINS`, and that list is what
   * takes it off a phone that already has one. `karaoke` is on it - the
   * plugin could only ever poll for a separation it could not queue, and it is
   * a core button now.
   *
   * Seeded through an init script so it is in storage BEFORE the bundle
   * evaluates, which is the only way to be the device that already had it.
   */
  await page.addInitScript(() => {
    localStorage.setItem(
      'attackfm-plugins-installed',
      JSON.stringify([
        {
          id: 'karaoke',
          name: 'Karaoke',
          version: '9.9.9',
          source: 'https://plugins.test',
          api: 1,
          code:
            'var AttackFMPluginExport={createPlugin:function(){' +
            'return {id:"karaoke",name:"Karaoke",description:"retired"};}};',
          installedAt: 1,
        },
      ]),
    );
  });

  // The repository is still offering it, because a publish is somebody else's
  // schedule and a hub can be behind for months.
  const repo = new PluginRepo();
  repo.publish({ id: 'karaoke', name: 'Karaoke', version: '9.9.9' });
  repo.publish({
    id: 'wayfarer',
    name: 'Wayfarer',
    version: '1.0.0',
    page: { id: 'main', label: 'Wayfarer', body: 'x' },
  });
  await serveRepos(page, repo);

  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();

  // Uninstalled on sight, without being asked.
  await expect.poll(() => installedPlugins(page)).toEqual([]);

  const modal = await openPlugins(page);
  await addStubSource(page, modal);

  // And not offered back. Installing a retired plugin is offering a round
  // trip: it lands, registers a second copy of a UI the app already carries,
  // and the prune removes it again at the next launch.
  await expect(modal.getByText('Wayfarer').first()).toBeVisible();
  await expect(modal.getByText('Karaoke')).toHaveCount(0);
  await expect(modal.getByRole('button', { name: 'Install' })).toHaveCount(1);

  expect(crashes).toEqual([]);
});

test('a bundle built for a newer host is refused, and nothing is persisted', async ({ page }) => {
  const crashes: string[] = [];
  page.on('pageerror', (error) => crashes.push(error.message));

  // The host table is a CONTRACT with a version on it. A bundle declaring an
  // api this build does not speak would be evaluated against a module table
  // missing whatever it was compiled for, and would fail somewhere far from
  // here - so it is refused at the door, by number, before a byte is stored.
  const repo = new PluginRepo();
  repo.publish({
    id: 'future',
    name: 'Future',
    version: '1.0.0',
    api: 2,
    page: { id: 'main', label: 'Future', body: 'x' },
  });
  await serveRepos(page, repo);

  await page.goto('/');
  const modal = await openPlugins(page);
  await addStubSource(page, modal);
  await modal.getByRole('button', { name: 'Install' }).click();

  // Said in the app's own voice, with the two numbers that explain it - not an
  // OS alert box, which on a phone webview may not appear at all.
  await expect(
    modal.getByText('Could not install Future: Future needs a newer app (plugin API 2, this app speaks 1)'),
  ).toBeVisible();

  // The offer is still an offer, and nothing was written.
  await expect(modal.getByRole('button', { name: 'Install' })).toBeVisible();
  await expect.poll(() => installedPlugins(page)).toEqual([]);
  await expect(modal.getByText('3 plugins · 3 enabled', { exact: false })).toBeVisible();

  expect(crashes).toEqual([]);
});
