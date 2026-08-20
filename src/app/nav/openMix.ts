import type { Track } from '../core/tauri.ts';

/**
 * The door to a mix page, for the surfaces that cannot be handed one.
 *
 * A mix - a curator's list, a plugin's tile - now opens as a page rather than
 * in a sheet, which means somebody has to push a detail onto the nav stack.
 * The trouble is where mix cards actually live: the Discover page and the DJ
 * booth, both of which are rendered as pages BESIDE the stack rather than
 * inside anything holding it, and one of which is reached through the plugin
 * page contract, whose render props are a published surface rather than ours
 * to grow for one caller.
 *
 * So this is the same channel `headerActions` opened, for the same reason and
 * with the same shape: a module singleton, because there is exactly one nav
 * stack for the app's whole life and the alternative is threading a prop
 * through every page that might one day show a list.
 *
 * Deliberately NOT a context: the callers are in different subtrees, one of
 * them behind the plugin boundary, and a provider wrapping all of them would
 * be most of App.tsx.
 */
type MixOpener = (title: string, tracks: Track[], emptyLabel?: string) => void;

let opener: MixOpener | null = null;

/** App registers the real navigator once, at mount. */
export function setMixOpener(fn: MixOpener | null): void {
  opener = fn;
}

/**
 * Open a list as a page. A no-op before the app has registered its navigator,
 * which is the right failure: the alternative is a card that throws, and a
 * card that does nothing for one frame during boot is invisible.
 */
export function openMix(title: string, tracks: Track[], emptyLabel?: string): void {
  opener?.(title, tracks, emptyLabel);
}
