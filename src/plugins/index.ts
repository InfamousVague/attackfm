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
export const PLUGINS: readonly Plugin[] = [spotifyImport];
