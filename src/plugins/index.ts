import { canRunSubprocesses } from '../app/platform.ts';
import type { Plugin } from './types.ts';
import { spotifyImport } from './spotify-import/index.tsx';

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
const REGISTERED: readonly Plugin[] = [spotifyImport];

/**
 * The plugins this device can host RIGHT NOW, given whether a server is
 * connected. Session-dependent because a `serverBacked` plugin (the importer
 * off a desktop) needs the hub to run its engine: present with a server,
 * absent without one. Called from the runtime with the live session so the
 * list re-filters on connect and disconnect; every consumer downstream still
 * sees one already-filtered list and never asks what platform it is on.
 *
 * - `desktopOnly` drops on anything but a subprocess-capable desktop.
 * - `serverBacked` (and not desktopOnly) needs EITHER a local engine
 *   (desktop) OR a connected server (anywhere) - so the importer reaches a
 *   phone the moment it signs in.
 */
export function availablePlugins(serverConnected: boolean): readonly Plugin[] {
  return REGISTERED.filter((plugin) => {
    if (plugin.desktopOnly) return canRunSubprocesses;
    if (plugin.serverBacked) return canRunSubprocesses || serverConnected;
    return true;
  });
}
