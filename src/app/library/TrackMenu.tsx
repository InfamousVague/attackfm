import { ContextMenu, MenuItem, useToast } from '@glacier/react';
import { fireNativeHaptic } from '../core/haptics.ts';
import {
  UserRound,
  ArrowDownToLine,
  Check,
  ListEnd,
  ListMusic,
  ListStart,
  Radio,
  SearchX,
  Sparkles,
  Trash2,
  CopyCheck,
} from '@glacier/icons';
import { Send } from '@glacier/icons';
import { useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AddToPlaylistDialog } from '../playlists/AddToPlaylist.tsx';
import { SendToFriendDialog } from '../profile/SendToFriend.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { SongSelectionContext } from './songSelection.tsx';
import { WrongSongModal } from './WrongSongModal.tsx';
import { useQueueControls } from '../player/queueControls.tsx';
import { isHeld, onOfflineChange, pinTrack, unpinTrack, vaultKey } from '../downloads/offline.ts';
import { cacheQualityKbps, markPinned } from '../cache/cacheStore.ts';
import { estimateBytes, extFor, wantedQuality } from '../cache/cacheQuality.ts';
import { useRadioOptional } from '../player/radio.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { streamUrl, trackIdFromPath, transcodeUrl } from '../server.ts';
import { isTauri, type Track } from '../core/tauri.ts';
import { DjTraitSheet } from '../booth/DjTraitSheet.tsx';
import { useHoldToMenu } from '../ux/holdToMenu.ts';
import { artistDoorOpen, openArtist } from '../nav/artistDoor.ts';

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
  const { toast } = useToast();
  /** One queue verb, said once. See the note at the menu items. */
  const queued = (t: Track, next: boolean) => {
    if (next) playNext(t);
    else addToQueue(t);
    fireNativeHaptic('light');
    toast({
      message: `“${t.title}” ${inJam ? 'sent to the jam' : next ? 'playing next' : 'added to the queue'}`,
    });
  };
  // The station: a song is the most natural thing to start one from, and the
  // menu is where "do something with this song" already lives.
  const radio = useRadioOptional();
  // Present only inside a table that supports selection - the item below
  // renders nowhere else, so a card or a search hit never offers a mode its
  // surface cannot enter.
  const selection = useContext(SongSelectionContext);
  const [filing, setFiling] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [exploring, setExploring] = useState(false);
  const [sending, setSending] = useState(false);
  // The wrapper is the menu's own target, so the hold resolves to itself: what
  // this adds over the kit's hold is the mouse, and swallowing the release so
  // the song under the menu does not start playing.
  const hold = useHoldToMenu((_from, root) => root);
  const [quickQueue, setQuickQueue] = useState(false);
  // Which dialogs have ever been opened - the mount gate for the block at the
  // bottom. A ref written during render, which is safe here: it only ever
  // goes false→true, and the render that flips it is the one the matching
  // state flag just re-triggered.
  const everOpened = useRef({ filing: false, reporting: false, exploring: false, quickQueue: false, sending: false });
  if (filing) everOpened.current.filing = true;
  if (sending) everOpened.current.sending = true;
  if (reporting) everOpened.current.reporting = true;
  if (exploring) everOpened.current.exploring = true;
  if (quickQueue) everOpened.current.quickQueue = true;
  // Keeping a song is only offered where it means something: a phone or
  // desktop app (a browser tab has no disk of ours) holding a track that came
  // from a server (a local file is already on this machine).
  const { session } = useServerSession();
  const trackId = trackIdFromPath(track.path);
  // Sending a song is between accounts on the registry, not between hubs, so
  // it needs the central sign-in rather than the server one.
  const registry = useRegistryOptional();
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
      // A hand-kept song obeys the download-quality setting like any other.
      // Both statements are honoured rather than one overruling the other: the
      // setting says what this device writes to disk, the keep says which song.
      // What a pin does NOT do is follow a later change to the setting - the
      // sweep requalifies its own files, but rewriting a song somebody asked
      // for by name is not the setting's business.
      const quality = wantedQuality(track, cacheQualityKbps());
      const url =
        quality === 0
          ? streamUrl(session, trackId)
          : transcodeUrl(session, trackId, quality, 0, null, null, null);
      /*
       * Throw away any half-finished fragment before a LOSSLESS pin.
       *
       * `offline_pin` names its fragment `<hex>.part` with no quality in it, and
       * the original-file endpoint honours a Range. So a stalled 128k encode
       * followed by a lossless keep resumes with `Range: bytes=N-`, gets a 206,
       * and appends FLAC onto an AAC head. `minBytes` cannot catch it - the
       * result is LARGER than the estimate, not smaller.
       *
       * This matters more here than in the sweep, because a hand pin is the one
       * copy that never heals itself: `markPinned` puts the key outside the
       * cache's ownership, and `planCache`, requalify and eviction all skip
       * anything on disk they do not own. A corrupt pin is served to the player
       * ahead of the network forever.
       *
       * Deliberately NOT gated on the setting having changed, the way the sweep
       * is. That marker is written per sweep, and a pinned key never appears in
       * a sweep's plan - so a sweep running after the change would clear the
       * marker without ever touching this fragment, disarming the guard on
       * precisely the case it exists for.
       *
       * `!isHeld` keeps the rule that a COMPLETE file is never deleted. The cost
       * is one directory read on a tap somebody made on purpose, and the loss is
       * resume for hand pins, which the structural fix (the extension in the
       * fragment's name, in offline.rs) would give back.
       */
      if (quality === 0 && !isHeld(track.path)) await unpinTrack(track.path);
      // Recorded as a deliberate keep, which is the whole difference between
      // this and the same file arriving from a sweep. Only on success: a mark
      // for a download that failed would protect a song that is not there.
      const kept = await pinTrack(track, url, {
        ext: extFor(track, quality),
        // Same reasoning as the sweep: a transcode has no length to check, and
        // the Rust side only refuses a download of exactly zero bytes.
        minBytes:
          quality !== 0 && track.duration
            ? Math.floor(estimateBytes(track, quality, 0) * 0.5)
            : 0,
      });
      if (kept) markPinned(vaultKey(track.path));
    } finally {
      setKeeping(false);
    }
  };

  return (
    <>
      <ContextMenu
        {...hold}
        aria-label={`${track.title} actions`}
        className={className}
        content={
          <>
            {/* Both queue verbs answer now. They were the highest-frequency
                "you did something and the app said nothing" in the app: the
                menu closed and the song went into a list you cannot see from
                where you are standing. The BULK version of the same verb has
                always toasted ("3 songs added to the queue", songSelection),
                so one song getting silence while three got a sentence was an
                oversight rather than a decision. Same wording, singular. */}
            <MenuItem icon={<ListStart size={15} />} onSelect={() => queued(track, true)}>
              Play next
            </MenuItem>
            {/* The artist's page, from any held song anywhere. Most cards
                print the name inside an element that is already a button, so
                the menu is the one place this door fits every surface at
                once - and books stay out, because authors have no page (the
                library keeps them off the music shelves ArtistPage reads). */}
            {artistDoorOpen() && track.kind !== 'book' && track.artist.trim() !== '' && (
              <MenuItem icon={<UserRound size={15} />} onSelect={() => openArtist(track.artist)}>
                Go to artist
              </MenuItem>
            )}
            <MenuItem icon={<ListEnd size={15} />} onSelect={() => queued(track, false)}>
              {inJam ? 'Add to jam queue' : 'Add to queue'}
            </MenuItem>
            {/* One item, not a submenu of every list: the panel it opens can
                search, create and un-add, none of which a nested menu of names
                can do. */}
            {selection && (
              <MenuItem icon={<CopyCheck size={15} />} onSelect={() => selection.start(track.path)}>
                Select songs…
              </MenuItem>
            )}
            <MenuItem icon={<ListMusic size={15} />} onSelect={() => setFiling(true)}>
              Add to playlist…
            </MenuItem>
            {/* By name, to a friend's own hub - no file leaves this one. */}
            {registry?.session && (
              <MenuItem icon={<Send size={15} />} onSelect={() => setSending(true)}>
                Send to a friend…
              </MenuItem>
            )}
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
      {/* Mounted on FIRST use, not always: this menu wraps every row of a
          five-thousand-song table, and four dialog components' worth of hooks
          and context subscriptions per row is most of what made that table
          heavy. Once opened, a dialog stays mounted with open=false so its
          exit animation still plays. */}
      {(filing || everOpened.current.filing) && (
        <AddToPlaylistDialog
          track={filing ? track : null}
          open={filing}
          onClose={() => setFiling(false)}
        />
      )}
      {(sending || everOpened.current.sending) && (
        <SendToFriendDialog track={track} open={sending} onClose={() => setSending(false)} />
      )}
      {(reporting || everOpened.current.reporting) && (
        <WrongSongModal
          track={reporting ? track : null}
          open={reporting}
          onClose={() => setReporting(false)}
        />
      )}
      {(exploring || everOpened.current.exploring) && (
        <DjTraitSheet track={track} open={exploring} onClose={() => setExploring(false)} />
      )}
      {(quickQueue || everOpened.current.quickQueue) && (
        <DjTraitSheet track={track} open={quickQueue} quick onClose={() => setQuickQueue(false)} />
      )}
    </>
  );
}
