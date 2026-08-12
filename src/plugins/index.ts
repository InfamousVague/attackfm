import { canRunSubprocesses } from '../app/platform.ts';
import type { Plugin } from './types.ts';
import { buy } from './buy/index.tsx';

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
const REGISTERED: readonly Plugin[] = [buy];

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
