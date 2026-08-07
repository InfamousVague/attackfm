import { canRunSubprocesses } from '../app/platform.ts';
import type { Plugin } from './types.ts';
import { spotifyImport } from './spotify-import/index.tsx';

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
 * The list, with anything the platform cannot host dropped.
 *
 * The filter is here rather than in the runtime so that every consumer -
 * slots, settings tabs, the marketplace, the palette - sees one list and none
 * of them has to ask what platform they are on. On a phone the importer simply
 * does not exist: it drives a Python downloader as a child process, and mobile
 * sandboxes forbid spawning executables at all.
 */
export const PLUGINS: readonly Plugin[] = REGISTERED.filter(
  (plugin) => !plugin.desktopOnly || canRunSubprocesses,
);
