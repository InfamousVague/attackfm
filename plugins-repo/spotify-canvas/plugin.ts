import { spotifyCanvas } from './index.tsx';

/**
 * The bundle's public face, same as every bundled plugin: the host evaluates
 * the built IIFE, finds this factory on its exports, and calls it once.
 */
export function createPlugin(): typeof spotifyCanvas {
  return spotifyCanvas;
}
