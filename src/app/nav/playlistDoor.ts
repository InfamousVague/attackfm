/**
 * A playlist page, reachable from outside the App's props.
 *
 * The bell draws a row that says "ana shared a playlist with you", and a row
 * that names a list is an offer to open it - but the bell is chrome with no
 * prop path to the nav stack. Same seam as the artist and Discover doors
 * beside it: App registers `goPlaylist` once, and the row knocks with the id.
 *
 * The id is the STORE's id (`Playlist.id`, the server's number as a string
 * for the primary hub), which is what `goPlaylist` and the playlist page both
 * already speak.
 */

let opener: ((id: string) => void) | null = null;

export function setPlaylistDoor(fn: ((id: string) => void) | null): void {
  opener = fn;
}

export function playlistDoorOpen(): boolean {
  return opener !== null;
}

export function openPlaylistById(id: string): void {
  if (id) opener?.(id);
}
