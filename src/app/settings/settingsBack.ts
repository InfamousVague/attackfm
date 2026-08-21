/**
 * One step back INSIDE settings, for the app's own back to consult first.
 *
 * Settings is a modal over everything, and it has its own depth: the phone
 * opens on a section list and drills into a pane. Until now nothing outside
 * knew that. The header's arrow ran `back()` on the page stack, which walked
 * the page UNDERNEATH the modal, and system back closed the whole surface from
 * however deep you were - so a press meant two different things depending on
 * which one you used, and neither was "go back one".
 *
 * A module singleton, the same channel `headerActions` and `openMix` use, and
 * for the same reason: the thing that knows the depth (MobileSettings) is
 * portalled out of the tree, and the thing that handles the press (App) is
 * above it. There is one settings surface for the app's life.
 *
 * The contract is deliberately a BOOLEAN rather than a void call. "Did you
 * consume this?" is the only question the caller can act on: false means there
 * is nothing left inside and closing is the right next step, which is also the
 * correct answer for the desktop layout, where the section rail has no
 * drill-down and every back is a close.
 */
type SettingsBackHandler = () => boolean;

let handler: SettingsBackHandler | null = null;

/** The settings surface registers itself while it is open. */
export function setSettingsBack(fn: SettingsBackHandler | null): void {
  handler = fn;
}

/** True if settings took the press; false if it has nowhere left to go. */
export function settingsBack(): boolean {
  return handler?.() ?? false;
}
