import { spotifyImport } from './index.tsx';

/**
 * The bundle's public face. The host evaluates the built bundle, finds this
 * factory on its exports, and calls it once with the host handle; everything
 * the plugin imports (react, glacier, the app seam) already resolves through
 * the host's module table, so the factory has nothing to wire - it just hands
 * the plugin object over.
 */
export function createPlugin(): typeof spotifyImport {
  return spotifyImport;
}
