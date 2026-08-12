import { librivox } from './index.tsx';

/** The bundle's public face: the host evaluates the built IIFE, finds this
 *  factory, and calls it once. */
export function createPlugin(): typeof librivox {
  return librivox;
}
