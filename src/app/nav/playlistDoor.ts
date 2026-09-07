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

/*
 * A page opened with something to show first. The New-playlist sheet lands
 * on the list it just made WITH the people it just added, and the page has
 * no prop for "open the Members face as you arrive" - so the hint rides
 * this door: set as the page is asked for, taken by the page as it mounts,
 * and stale after a moment so a hint nobody took cannot pop a sheet on
 * some later visit.
 */
let membersHint: { id: string; at: number } | null = null;
const HINT_MS = 8000;

/** Open a playlist's page, and (with `members`) its Members face on arrival. */
export function openPlaylistWith(id: string, opts: { members?: boolean } = {}): void {
  membersHint = opts.members ? { id, at: Date.now() } : null;
  openPlaylistById(id);
}

/** The page asks once as it mounts; taking clears it. */
export function takeMembersHint(id: string): boolean {
  const live = membersHint !== null && membersHint.id === id && Date.now() - membersHint.at < HINT_MS;
  if (membersHint?.id === id) membersHint = null;
  return live;
}
