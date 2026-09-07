import { canRunSubprocesses } from '../app/core/platform.ts';
import type { Plugin } from './types.ts';
import { buy } from './buy/index.tsx';
import { books } from './books/index.tsx';
import { visualizers } from './visualizers/index.tsx';

export type { Plugin } from './types.ts';

/**
 * Every plugin the build carries, in the order their contributions render,
 * their providers nest, and their palette commands merge. The array is the
 * whole discovery story - adding a plugin is adding a line - and the single
 * ordering authority: slots never sort, they walk it. Deliberately explicit
 * rather than glob-discovered, so the order is in version control and
 * identical on every machine.
 *
 * Layering: plugins import '../types.ts', 'src/app/*', and their own modules -
 * never runtime.tsx or this file.
 */
// The importer ships through the plugin repository now (plugins-repo/),
// installed from Settings -> Plugins rather than compiled in.
//
// Pads was here briefly - the sampler half of stems, a board you played the
// parts on with your thumbs. It is gone because the half people actually
// wanted turned out to be the quiet one: taking a part OUT of the song you are
// already listening to, which is the console's Stems tab and needs no screen
// of its own. A board is a destination, and a destination in the navigation is
// a claim on attention that has to keep earning itself. This one stopped.
//
// The code is in the history (see the commit that removed it) rather than
// parked here unreferenced, because a directory nothing imports rots quietly
// and a commit does not.
const REGISTERED: readonly Plugin[] = [buy, books, visualizers];

/**
 * The plugins this device can host RIGHT NOW, given whether a server is
 * connected. Session-dependent because a `serverBacked` plugin (the importer
 * off a desktop) needs the hub to run its engine: present with a server,
 * absent without one. Called from the runtime with the live session so the
 * list re-filters on connect and disconnect; every consumer downstream still
 * sees one already-filtered list and never asks what platform it is on.
 *
 * - `desktopOnly` drops on anything but a subprocess-capable desktop.
 * - `requiresServer` needs a connected server on EVERY platform - no local
 *   equivalent exists (the discover feed is built on the hub), so a desktop
 *   without one shows nothing either.
 * - `serverBacked` (and not desktopOnly) needs EITHER a local engine
 *   (desktop) OR a connected server (anywhere) - so the importer reaches a
 *   phone the moment it signs in.
 */
export function availablePlugins(serverConnected: boolean): readonly Plugin[] {
  return filterAvailable(REGISTERED, serverConnected);
}

/**
 * The availability rule on its own, because two lists pass through it now:
 * the compiled-in registry above, and whatever the user has installed from
 * plugin repositories - a remote plugin declares the same flags and answers
 * to the same platform truths.
 */
export function filterAvailable(
  plugins: readonly Plugin[],
  serverConnected: boolean,
): readonly Plugin[] {
  return plugins.filter((plugin) => {
    if (plugin.desktopOnly) return canRunSubprocesses;
    if (plugin.requiresServer) return serverConnected;
    if (plugin.serverBacked) return canRunSubprocesses || serverConnected;
    return true;
  });
}

/** Every compiled-in id, for collision checks against remote installs. */
export function registeredIds(): ReadonlySet<string> {
  return new Set(REGISTERED.map((p) => p.id));
}

/**
 * The compiled-in plugins, with their words put back.
 *
 * A plugin object is module-scope data: `buy`, `books` and `visualizers` are
 * built the moment this file is imported, which is before anybody has chosen a
 * language. So those three carry catalogue KEYS in their text fields, and this
 * turns them back into prose at render - once, at the one place every consumer
 * reads the list from (PluginsProvider), so the marketplace card, the detail
 * dialog, the settings tab and the nav item are all covered by one call.
 *
 * ONLY the compiled-in set goes through here. A plugin installed from a
 * repository ships its own English and has no entries in our catalogue;
 * handing a whole sentence to t() would be asking i18next about a key that
 * happens to be a paragraph.
 */
export function localizePlugins(
  plugins: readonly Plugin[],
  t: (key: string) => string,
): readonly Plugin[] {
  return plugins.map((plugin) => ({
    ...plugin,
    name: t(plugin.name),
    description: t(plugin.description),
    ...(plugin.details ? { details: t(plugin.details) } : {}),
    ...(plugin.tags ? { tags: plugin.tags.map((tag) => t(tag)) } : {}),
    ...(plugin.settingsSections
      ? { settingsSections: plugin.settingsSections.map((s) => ({ ...s, label: t(s.label) })) }
      : {}),
    ...(plugin.pages ? { pages: plugin.pages.map((page) => ({ ...page, label: t(page.label) })) } : {}),
    ...(plugin.downloads
      ? { downloads: plugin.downloads.map((source) => ({ ...source, label: t(source.label) })) }
      : {}),
  }));
}
