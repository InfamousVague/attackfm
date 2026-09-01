import { ContextMenu, MenuItem } from '@glacier/react';
import { Heart, ListMusic, Plus, UserRound } from '@glacier/icons';
import { useRef, useState, type ReactNode } from 'react';
import { AddToPlaylistDialog, type PlaylistWantTarget } from '../playlists/AddToPlaylist.tsx';
import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { artistDoorOpen, openArtist } from '../nav/artistDoor.ts';

/**
 * The context menu for a song you do NOT own yet - a catalogue result, a
 * Popular row, an album gap. The owned-song menu (TrackMenu) cannot serve these
 * rows: its verbs (queue, radio, keep-on-device) all need a real file, and the
 * whole point of these rows is that there is not one. So this is the not-owned
 * twin, and it exists for the one thing you genuinely can do with a song before
 * you have it: file it into a playlist to acquire.
 *
 * "Add to playlist…" writes a WANT - the song shows in the list as an arriving
 * ghost and its download starts at once, becoming an ordinary row when it lands
 * (see AddToPlaylist / playlist_wants). "Add" and "Like" are the surface's own
 * existing acquire actions, offered here too when it hands them down, so the
 * long-press is not a lesser menu than the buttons already on the row.
 *
 * Wear it wherever a not-owned song is drawn, the way TrackMenu is worn on
 * owned ones - a song is the same song whichever shelf you found it on.
 */
export function CatalogTrackMenu({
  target,
  children,
  className,
  onAdd,
  onLike,
  liked,
}: {
  /** The song this menu acts on. `url` is the catalogue link, when known. */
  target: PlaylistWantTarget;
  children: ReactNode;
  className?: string;
  /** The surface's "add to library" (download only) - its existing + button. */
  onAdd?: () => void;
  /** The surface's love-and-download. */
  onLike?: () => void;
  /** Whether this song is already loved, so the item reads as done. */
  liked?: boolean;
}) {
  const [filing, setFiling] = useState(false);
  // Mounted on first use, like TrackMenu: this wraps every row of long
  // catalogue lists, and the dialog's hooks per row are what to avoid.
  const everFiled = useRef(false);
  if (filing) everFiled.current = true;
  // The wrapper is the menu's own target, so the hold resolves to itself and
  // the release is swallowed rather than falling through to the row.
  const hold = useHoldToMenu((_from, root) => root);
  const artist = target.artist.trim();
  // The wrapper is always `display: contents` (styles/36 .catalogTrackMenu) so
  // it adds no box of its own - the wrapped row participates in its list/flex
  // parent directly. Without this the ContextMenu's <div> becomes a stray flex
  // item (and, inside an <ol>, invalid <ol><div><li> markup).
  const wrapClass = className ? `catalogTrackMenu ${className}` : 'catalogTrackMenu';
  return (
    <>
      <ContextMenu
        {...hold}
        aria-label={`${target.title} actions`}
        className={wrapClass}
        content={
          <>
            <MenuItem icon={<ListMusic size={15} />} onSelect={() => setFiling(true)}>
              Add to playlist…
            </MenuItem>
            {onAdd && (
              <MenuItem icon={<Plus size={15} />} onSelect={onAdd}>
                Add to library
              </MenuItem>
            )}
            {onLike && (
              <MenuItem icon={<Heart size={15} />} onSelect={onLike}>
                {liked ? 'Loved' : 'Love this song'}
              </MenuItem>
            )}
            {artistDoorOpen() && artist !== '' && (
              <MenuItem icon={<UserRound size={15} />} onSelect={() => openArtist(artist)}>
                Go to artist
              </MenuItem>
            )}
          </>
        }
      >
        {children}
      </ContextMenu>
      {(filing || everFiled.current) && (
        <AddToPlaylistDialog want={filing ? target : null} open={filing} onClose={() => setFiling(false)} />
      )}
    </>
  );
}
