import { audible } from './index.tsx';

/**
 * The bundle's public face, same as every bundled plugin: the host evaluates
 * the built IIFE, finds this factory on its exports, and calls it once. Every
 * import the plugin makes (react, glacier, the app seam) resolves through the
 * host's module table, so the factory just hands the plugin object over.
 */
export function createPlugin(): typeof audible {
  return audible;
}
