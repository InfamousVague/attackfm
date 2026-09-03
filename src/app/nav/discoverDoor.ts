/**
 * The Discover tab, reachable from outside the App's props.
 *
 * A notification row that says "new music picked for you" has to be able to
 * open Discover when it is pressed, and it is rendered by the bell - a piece of
 * chrome with no prop path to the nav stack. Rather than thread a handler
 * through every place the bell is drawn, App registers the opener once and the
 * bell knocks, exactly like the Music Date door beside it.
 */

let opener: (() => void) | null = null;

export function setDiscoverDoor(fn: (() => void) | null): void {
  opener = fn;
}

export function discoverDoorOpen(): boolean {
  return opener !== null;
}

export function openDiscover(): void {
  opener?.();
}
