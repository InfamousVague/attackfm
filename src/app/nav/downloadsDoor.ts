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

/**
 * A pasted link that is a PLAYLIST, by its shape - a playlist path on the
 * services the importer takes, or a `list=` query (YouTube Music). Albums and
 * singles are done before you would look up; a playlist is many songs over
 * minutes, the one import worth being taken to watch.
 */
export function looksLikePlaylist(url: string): boolean {
  return /\/playlist\//i.test(url) || /[?&]list=/.test(url);
}

/**
 * Open the Downloads pane the moment a PLAYLIST import starts, from wherever it
 * was started - so the queue lands somewhere you can watch it fill rather than
 * behind the search or preview you kicked it off from. A no-op for a single or
 * an album, which finish too fast to move the page for, so every import site
 * can call it with whatever URL it just enqueued.
 */
export function watchIfPlaylist(url: string): void {
  if (looksLikePlaylist(url)) openDownloadsPane();
}
