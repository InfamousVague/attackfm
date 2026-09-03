/**
 * The Downloads pane's opener, reachable from outside App's props.
 *
 * Downloads stopped being a destination - the songs land where they will live
 * - but there is still a pane that keeps the full queue with its retry and
 * cancel. A pasted playlist is the one import worth watching land (it is many
 * songs over minutes, not one that is done before you look up), so the paste
 * field wants to take you there. That field is a leaf with no prop path to
 * App's settings state, so the door is a module seam, exactly like the artist
 * and Music Date doors beside it: App registers the opener once, the leaf
 * knocks.
 */

let opener: (() => void) | null = null;

export function setDownloadsDoor(fn: (() => void) | null): void {
  opener = fn;
}

export function downloadsDoorOpen(): boolean {
  return opener !== null;
}

export function openDownloadsPane(): void {
  opener?.();
}
