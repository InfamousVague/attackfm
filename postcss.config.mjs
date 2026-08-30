/**
 * There was no PostCSS config here before, so this file adds exactly one thing
 * and inherits nothing: Vite's own CSS handling (nesting, url rewriting,
 * minification) is unaffected by its presence.
 *
 * See build/hoverIsNotATap.mjs for why a stylesheet transform is the right
 * place to fix a touch-device behaviour.
 */
import hoverIsNotATap from './build/hoverIsNotATap.mjs';

export default {
  plugins: [hoverIsNotATap()],
};
