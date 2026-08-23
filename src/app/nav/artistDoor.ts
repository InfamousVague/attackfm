/**
 * The artist page, reachable from anywhere an artist's name appears.
 *
 * An audit found fifteen surfaces printing an artist's name as dead text - the
 * queue panel, the stats rows, a friend's week, the strip's own subtitle -
 * and every one of them was dead for the same reason: `onOpenArtist` lives at
 * the top of the app and reaching a leaf means threading a prop through every
 * layer between, which is exactly the kind of errand that stops happening.
 *
 * So the door is a module seam, like the header's action slot: App registers
 * the real navigation once, and any surface may knock. A name is enough - the
 * artist page opens by name string, inside whichever tab is current.
 *
 * Callers that live in an overlay (a panel, a modal, a sheet) close
 * themselves BEFORE knocking; the door cannot know what is stacked over the
 * page it opens.
 */

let opener: ((artist: string) => void) | null = null;

/** App calls this once, with the same `go` its props plumbing uses. */
export function setArtistDoor(fn: ((artist: string) => void) | null): void {
  opener = fn;
}

/** Whether knocking would do anything - lets a surface render a plain span
 *  rather than a dead button when navigation is not mounted (tests, previews). */
export function artistDoorOpen(): boolean {
  return opener !== null;
}

export function openArtist(artist: string): void {
  const name = artist.trim();
  if (name) opener?.(name);
}
