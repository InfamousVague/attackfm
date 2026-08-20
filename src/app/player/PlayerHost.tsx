import { useEffect } from 'react';
import { useConnect } from './playbackSync.tsx';
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
  const { tracks } = useLibrary();
  const elsewhere =
    connect.session?.activeDeviceId != null &&
    connect.session.activeDeviceId !== connect.thisDeviceId;
  const remoteId = elsewhere ? connect.session?.trackId : null;
  const remoteTrack =
    remoteId != null
      ? (tracks.find((t) => trackIdFromPath(t.path) === remoteId) ?? null)
      : null;
  // A local track always wins: this device's own deck is what its transport
  // drives once it has one.
  const shown = current ?? remoteTrack;
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
      const activeElsewhere =
        connect.connected &&
        connect.session?.activeDeviceId != null &&
        connect.session.activeDeviceId !== connect.thisDeviceId;
      if (!activeElsewhere) return false;
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
