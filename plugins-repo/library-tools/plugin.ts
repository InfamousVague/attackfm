import { libraryTools } from './index.tsx';

/**
 * The bundle's public face, same as every bundled plugin: the host evaluates
 * the built IIFE, finds this factory on its exports, and calls it once. All
 * the wiring (react, glacier, the app seam) already resolves through the
 * host's module table, so there is nothing to pass - just the plugin object.
 */
export function createPlugin(): typeof libraryTools {
  return libraryTools;
}
