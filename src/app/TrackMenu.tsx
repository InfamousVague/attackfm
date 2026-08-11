import { ContextMenu, MenuItem } from '@glacier/react';
import { ListEnd, ListMusic, ListStart } from '@glacier/icons';
import { useState, type ReactNode } from 'react';
import { AddToPlaylistDialog } from './AddToPlaylist.tsx';
import { useQueueControls } from './queueControls.tsx';
import type { Track } from './tauri.ts';

/**
 * The three things you can do to a song that are not "play it", wrapped around
 * whatever shows the song: play it next, put it at the end of the queue, or
 * file it in a playlist.
 *
 * Every surface that draws a track should wear this, because the alternative is
 * what the app had - the menu on the song table and nowhere else, so filing a
 * song you found on a shelf meant going to find it again somewhere it had a
 * menu. A song is the same song whichever picture of it you are looking at.
 *
 * `ContextMenu` is the right shell for it: a right-click on the desktop and a
 * long-press on touch, both without spending any pixels. A card keeps looking
 * like a card, and the menu is there when it is wanted.
 *
 * The dialog rather than the popover: these callers are cards and rows in
 * scrolling shelves, and a popover anchored to something the user is mid-scroll
 * on lands wrong as often as it lands right.
 */
export function TrackMenu({
  track,
  children,
  className,
}: {
  track: Track;
  /** What the menu wraps - the card, the row, the tile. */
  children: ReactNode;
  className?: string;
}) {
  const { playNext, addToQueue, inJam } = useQueueControls();
  const [filing, setFiling] = useState(false);

  return (
    <>
      <ContextMenu
        aria-label={`${track.title} actions`}
        className={className}
        content={
          <>
            <MenuItem icon={<ListStart size={15} />} onSelect={() => playNext(track)}>
              Play next
            </MenuItem>
            <MenuItem icon={<ListEnd size={15} />} onSelect={() => addToQueue(track)}>
              {inJam ? 'Add to jam queue' : 'Add to queue'}
            </MenuItem>
            {/* One item, not a submenu of every list: the panel it opens can
                search, create and un-add, none of which a nested menu of names
                can do. */}
            <MenuItem icon={<ListMusic size={15} />} onSelect={() => setFiling(true)}>
              Add to playlist…
            </MenuItem>
          </>
        }
      >
        {children}
      </ContextMenu>
      <AddToPlaylistDialog
        track={filing ? track : null}
        open={filing}
        onClose={() => setFiling(false)}
      />
    </>
  );
}
