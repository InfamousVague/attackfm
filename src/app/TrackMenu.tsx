import { ContextMenu, MenuItem } from '@glacier/react';
import {
  ArrowDownToLine,
  Check,
  ListEnd,
  ListMusic,
  ListStart,
  Radio,
  SearchX,
  Sparkles,
  Trash2,
} from '@glacier/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { AddToPlaylistDialog } from './AddToPlaylist.tsx';
import { WrongSongModal } from './WrongSongModal.tsx';
import { useQueueControls } from './queueControls.tsx';
import { isHeld, onOfflineChange, pinTrack, unpinTrack } from './offline.ts';
import { useRadioOptional } from './radio.tsx';
import { useServerSession } from './serverSession.tsx';
import { streamUrl, trackIdFromPath } from './server.ts';
import { isTauri, type Track } from './tauri.ts';
import { DjTraitSheet } from './DjTraitSheet.tsx';

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
  // The station: a song is the most natural thing to start one from, and the
  // menu is where "do something with this song" already lives.
  const radio = useRadioOptional();
  const [filing, setFiling] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [quickQueue, setQuickQueue] = useState(false);
  // Keeping a song is only offered where it means something: a phone or
  // desktop app (a browser tab has no disk of ours) holding a track that came
  // from a server (a local file is already on this machine).
  const { session } = useServerSession();
  const trackId = trackIdFromPath(track.path);
  const canKeep = isTauri() && session !== null && trackId !== null;
  // Replacing the file is a change to the shared library, so it takes the same
  // rank the server asks for; a non-admin would only get a 403 from the menu.
  const canReport = session !== null && trackId !== null && session.isAdmin;
  const [keeping, setKeeping] = useState(false);
  const [held, setHeld] = useState(() => isHeld(track.path));
  useEffect(() => {
    setHeld(isHeld(track.path));
    return onOfflineChange(() => setHeld(isHeld(track.path)));
  }, [track.path]);

  const keep = async () => {
    if (!session || trackId === null || keeping) return;
    setKeeping(true);
    try {
      await pinTrack(track, streamUrl(session, trackId));
    } finally {
      setKeeping(false);
    }
  };

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
            {/* An endless run in this song's direction. It plays first, and
                the station keeps the queue fed behind it for as long as it
                is on - see radio.tsx. */}
            {radio && session && (
              <MenuItem
                icon={<Radio size={15} />}
                onSelect={() => {
                  // The seed plays first - a station "from this song" that did
                  // not play it would be a station from somewhere else.
                  playNext(track);
                  radio.start(track);
                }}
              >
                Start radio from this
              </MenuItem>
            )}
            {session && trackId !== null && (
              <>
                <MenuItem icon={<Sparkles size={15} />} onSelect={() => setQuickQueue(true)}>
                  Generate custom queue
                </MenuItem>
                <MenuItem icon={<Sparkles size={15} />} onSelect={() => setExploring(true)}>
                  Choose the sound for a mix…
                </MenuItem>
              </>
            )}
            {/* The song, on this device: it plays with the hub off, the wifi
                gone, or the plane door shut. Held songs offer the way back
                out, since the whole point is that the space is yours. */}
            {/* The importer matches a song by searching for its title and
                artist, so it can arrive as a live cut, a remix, or a cover -
                correctly tagged either way, which is why only a listener ever
                catches it. Offered wherever a song is, because that is where
                you are standing when you notice. Admin-only: it edits a file
                the whole server shares. */}
            {canReport && (
              <MenuItem icon={<SearchX size={15} />} onSelect={() => setReporting(true)}>
                Wrong song?
              </MenuItem>
            )}
            {canKeep &&
              (held ? (
                <MenuItem icon={<Trash2 size={15} />} onSelect={() => void unpinTrack(track.path)}>
                  Remove from this device
                </MenuItem>
              ) : (
                <MenuItem
                  icon={keeping ? <Check size={15} /> : <ArrowDownToLine size={15} />}
                  onSelect={() => void keep()}
                >
                  {keeping ? 'Keeping…' : 'Keep on this device'}
                </MenuItem>
              ))}
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
      <WrongSongModal
        track={reporting ? track : null}
        open={reporting}
        onClose={() => setReporting(false)}
      />
      <DjTraitSheet track={track} open={exploring} onClose={() => setExploring(false)} />
      <DjTraitSheet track={track} open={quickQueue} quick onClose={() => setQuickQueue(false)} />
    </>
  );
}
