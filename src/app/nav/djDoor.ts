/**
 * The door into the DJ conversation, from anywhere.
 *
 * The conversation is a fullscreen layer owned by App (see the note there),
 * and until now the only thing that opened it was a button on the Booth -
 * a developer-mode page. So outside developer mode there was no road to the
 * DJ's chat at all, and none to its microphone. The owner's words: "there is
 * no longer a spot for me to talk to the DJ with my voice." Same seam as
 * artistDoor and playlistDoor: App registers the opener, surfaces ask.
 */
let opener: (() => void) | null = null;

export function setDjDoor(fn: (() => void) | null): void {
  opener = fn;
}

export function djDoorOpen(): boolean {
  return opener !== null;
}

export function openDj(): void {
  opener?.();
}
