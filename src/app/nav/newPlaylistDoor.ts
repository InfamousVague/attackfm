import type { PlaylistWantTarget } from '../playlists/AddToPlaylist.tsx';

/**
 * The door onto the New-playlist sheet.
 *
 * Every "New playlist…" in the app - the add-to-playlist panel, the
 * Library shelf's tile, the "where does this download go?" chooser - used
 * to open its own little name field. One sheet now (playlists/
 * NewPlaylistSheet.tsx, hoisted to app level), with the name, the
 * description and the collaborative switch on it, and each seat knocks
 * here with what it knows: the songs the list should be born holding, a
 * name to suggest, and what to do with the id once it exists.
 */
export interface NewPlaylistRequest {
  /** Owned songs the list is born holding, by path. */
  paths?: readonly string[];
  /** A not-owned song to file into it as a want (plan to acquire). */
  want?: PlaylistWantTarget | null;
  /** A name to offer - the song's title, usually. Used when the field is
   *  left empty, so a list is never called "New Playlist" for no reason. */
  seed?: string;
  /** What the seat that asked does with the new list. Absent means the
   *  sheet opens the list's page itself. */
  onCreated?: (id: string, name: string) => void;
}

let held: NewPlaylistRequest | null = null;
const listeners = new Set<(req: NewPlaylistRequest) => void>();

export function openNewPlaylist(request: NewPlaylistRequest = {}): void {
  held = request;
  for (const fn of listeners) fn(request);
}

export function onNewPlaylist(fn: (req: NewPlaylistRequest) => void): () => void {
  listeners.add(fn);
  if (held) fn(held);
  return () => {
    listeners.delete(fn);
  };
}

/** Taken once: a closed sheet must not reopen on the next subscriber. */
export function clearNewPlaylist(): void {
  held = null;
}
