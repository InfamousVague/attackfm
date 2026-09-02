/**
 * Music Date's fullscreen layer, reachable from outside the App's props.
 *
 * The layer itself lives in App (a fixed layer inside the swipe host's
 * transform would be trapped under the chrome), and App used to hand its
 * opener to the one page that offered the door. The invitation is a chip on
 * the Discover page now, deep in a tree with no prop path from App - so the
 * door is a module seam, exactly like the artist door beside it: App
 * registers the opener once, and the chip knocks.
 */

let opener: (() => void) | null = null;

export function setMusicDateDoor(fn: (() => void) | null): void {
  opener = fn;
}

export function musicDateDoorOpen(): boolean {
  return opener !== null;
}

export function openMusicDate(): void {
  opener?.();
}
