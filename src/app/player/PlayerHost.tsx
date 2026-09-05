import { useEffect } from 'react';
import { useConnect } from './playbackSync.tsx';
import { useJamOptional } from './jam.tsx';
import { useLibrary } from '../library/library.tsx';
import { trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';
import { Player } from './Player.tsx';

/**
 * Whether the strip exists, and what it holds.
 *
 * A device that has played nothing of its own still needs the transport when
 * the music is playing SOMEWHERE: Connect makes every signed-in device a remote
 * for whichever one holds the audio, and a remote with no strip can neither
 * watch the progress nor take the controls - which is most of the point of
 * having Connect at all. So the bar appears for a local track OR for the track
 * another device is playing, and the Player's own remote mode does the rest
 * (it shows that device's clock and sends commands instead of playing).
 *
 * The same holds for a GROOVE you are following: the host's song is the one
 * this device should be steering to, and the steering lives in the Player -
 * so a guest who joined with an idle deck had no Player to follow with, and
 * no queue panel to send songs from. The room's track stands the strip up,
 * the way a remote's does; the Player then takes the song over as its own
 * (usePlayerConnect's follow, which treats a deck it does not own yet as a
 * different song and resumes at the host's position).
 *
 * Lives inside the Connect provider because only a child of it can read the
 * shared session.
 */
export function PlayerHost({
  current,
  queue,
  onTrackChange,
  onQueueChange,
  onOpenArtist,
  autoplay,
  deckEngaged = false,
  hidden = false,
}: {
  current: Track | null;
  queue: Track[];
  onTrackChange: (track: Track) => void;
  onQueueChange: (queue: Track[]) => void;
  /** The Now Playing sheet's artist line opens the artist page through here. */
  onOpenArtist: (artist: string) => void;
  autoplay: boolean;
  /** Whether anyone has picked a song yet, as against the launch seed having
   *  loaded one. Only the split view reads it; see App. */
  deckEngaged?: boolean;
  /** Date mode's floor: the strip hides (and the page below reclaims its
   *  space) while the deck itself stays mounted - tearing the Player down
   *  would take the audio graph, the scrub state and the session's seed with
   *  it, when all Date needs is silence and a clean screen. DatePage pauses
   *  the audio on entry; this keeps the paused strip from hanging under the
   *  cards pretending something is playing. */
  hidden?: boolean;
}) {
  const connect = useConnect();
  // `allTracks`, not `tracks`: the other device may be playing a book or a
  // Music Date audition, and neither is on the music shelf. See library.tsx.
  const { allTracks } = useLibrary();
  // The provider's definition, not a second one of our own: this read used
  // `session.activeDeviceId` while the Player used `activeDeviceId`, and the
  // two are written by different message types - so the strip and the deck
  // inside it could disagree about whether this device was a remote.
  const elsewhere = connect.activeElsewhere;
  const remoteId = elsewhere ? connect.session?.trackId : null;
  const remoteTrack =
    remoteId != null
      ? (allTracks.find((t) => trackIdFromPath(t.path) === remoteId) ?? null)
      : null;
  // Following a groove with nothing of our own on: the room's song.
  const jam = useJamOptional();
  const room = jam?.current ?? null;
  const roomId = room !== null && !jam?.hosting ? room.trackId : null;
  const roomTrack =
    roomId != null ? (allTracks.find((t) => trackIdFromPath(t.path) === roomId) ?? null) : null;
  // A local track always wins: this device's own deck is what its transport
  // drives once it has one.
  const shown = current ?? remoteTrack ?? roomTrack;
  /**
   * Whether the strip's track is this device's OWN deck, or a mirror of one
   * elsewhere. `current` is the app's track - set only by something this
   * device chose to play - so a device that has done nothing but watch shows
   * a track it does not hold.
   *
   * The Connect hand-off has to know the difference. `shown` looks the same
   * either way, and a device handed the seat while mirroring must LOAD the
   * song rather than assume its deck already has it.
   */
  const deckOwned = current !== null;
  if (!shown) return null;
  return (
    <div className="appPlayer" data-hidden={hidden || undefined}>
      {/* The player walks the queue itself; it only reports where it
          landed, and `current` follows. */}
      <Player
        track={shown}
        queue={queue}
        onTrackChange={onTrackChange}
        onQueueChange={onQueueChange}
        onOpenArtist={onOpenArtist}
        // Nothing this device chose to play, so nothing to start.
        autoplay={current ? autoplay : false}
        deckEngaged={deckEngaged}
        // Date and the DJ take the whole screen. The strip below is hidden by
        // `hidden` on the wrapper, but the docked sheet PORTALS to the body -
        // so without this it kept standing in the right half, on top of a
        // surface whose whole point is that nothing else is on screen.
        chromeHidden={hidden}
        // The docked sheet may only stand for THIS device's deck. While the
        // strip mirrors a remote the sheet's own clock and transport are
        // honestly empty - it was never reachable in that state before the
        // dock existed, and mounting it there showed a dead player beside a
        // live strip.
        deckOwned={deckOwned}
      />
    </div>
  );
}

/**
 * Bridges playFrom to AttackFM Connect. Renders nothing; it just keeps a router
 * function in the ref App holds, refreshed whenever the shared session changes.
 * When another device holds audio, the router forwards a pick to it as a
 * setQueue command (the whole list, so that device's skips follow it) and
 * returns true; App then skips local playback, so a song picked on any device -
 * even one not playing the audio - changes the song for every device.
 */
export function ConnectPlayRouter({
  routeRef,
}: {
  routeRef: { current: ((track: Track, context?: Track[]) => boolean) | null };
}) {
  const connect = useConnect();
  useEffect(() => {
    routeRef.current = (track, context) => {
      // Same definition as everywhere else. This one additionally required
      // `connected`, so a remote whose socket had merely blipped answered "no
      // other device is playing", fell through to a LOCAL play - and the deck
      // then refused to load it, because the Player still (correctly) knew it
      // was a remote. The pick vanished: nothing here, nothing there.
      //
      // Dropping the gate is safe because the socket already handles this:
      // `command()` holds the latest command for three seconds and forces the
      // reconnect itself (connect.ts), so a pick made during a blip lands on
      // the device that is actually playing a moment later.
      if (!connect.activeElsewhere) return false;
      const list = context ?? [track];
      const ids = list
        .map((t) => trackIdFromPath(t.path))
        .filter((x): x is number => x !== null);
      if (ids.length === 0) return false;
      const pickId = trackIdFromPath(track.path);
      const index = Math.max(
        0,
        pickId == null ? 0 : ids.indexOf(pickId),
      );
      connect.sendCommand({ action: 'setQueue', queue: ids, index });
      return true;
    };
    return () => {
      routeRef.current = null;
    };
  }, [connect, routeRef]);
  return null;
}
