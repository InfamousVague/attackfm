import { useEffect, useMemo } from 'react';
import { useConnect } from './playbackSync.tsx';
import { useJamOptional } from './jam.tsx';
import { useLibrary } from '../library/library.tsx';
import { trackIdFromPath } from '../server.ts';
import type { Track } from '../core/tauri.ts';
import { Player } from './Player.tsx';
import { useRoomTrack } from './roomTrack.ts';
import type { FollowingRoom } from './deckShared.ts';

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
 * And when the room's song is NOT in this library there is still a strip -
 * a FOLLOWING one, reading the room by name (`following`, below). Before it
 * a join into such a room succeeded with nothing on screen at all: no track
 * to stand the strip on, so no strip, so no Now Playing and no groove deck
 * to say you were in.
 *
 * Lives inside the Connect provider because only a child of it can read the
 * shared session.
 */
export function PlayerHost({
  current,
  queue,
  upNext,
  onTrackChange,
  onQueueChange,
  onUpNextChange,
  onOpenArtist,
  autoplay,
  deckEngaged = false,
  hidden = false,
}: {
  current: Track | null;
  queue: Track[];
  /** The songs the listener queued by hand. Played before the context list,
   *  and the only lane the queue panel calls "the queue". */
  upNext: Track[];
  onTrackChange: (track: Track) => void;
  onQueueChange: (queue: Track[]) => void;
  onUpNextChange: (upNext: Track[]) => void;
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
  const hosting = !!jam?.hosting;
  const roomId = room !== null && !hosting ? room.trackId : null;
  // The room's song: this library's own row, or the hub's (roomTrack.ts). A
  // song promoted for the host alone is on this hub and streams to this
  // member - it just never made this library's listing, and looking it up
  // here alone left the follower a disc by name and no sound. `undefined`
  // while the hub is being asked; `null` once it has said no such row.
  const roomAnswer = useRoomTrack(roomId);
  const roomTrack = roomAnswer ?? null;
  const roomMissing = roomAnswer === null;
  // Hearing the room on the host's speaker: this deck is SILENT. The room's
  // song must not stand the strip up as a track of this deck's - the Player
  // would load it - so it is kept out of `shown` and carried on `following`.
  const silent = room !== null && !hosting && jam?.hear === 'speaker';
  // A local track always wins: this device's own deck is what its transport
  // drives once it has one.
  const shown = current ?? remoteTrack ?? (silent ? null : roomTrack);
  /*
   * STANDING IN A ROOM WITHOUT THE DECK CARRYING IT.
   *
   * Three cases, one state (`FollowingRoom`, deckShared.ts):
   *
   *  - Hearing the room on the host's SPEAKER: the deck loads nothing, and
   *    the strip reads the room - the sleeve when the library has the song,
   *    the Users mark by name when it does not - with the room's own clock
   *    and a transport whose presses go to the room.
   *  - Hearing it HERE, and the song on is not in this library (or the host
   *    has nothing on yet): the deck has nothing for it, so the same strip
   *    stands, room mark and "not in your library". The moment the room
   *    moves to a song this library has, `roomTrack` lands, this goes null
   *    and the ordinary player takes over (the follow seam loads it); moving
   *    on to one it lacks brings this back over whatever the deck still
   *    holds - the seam pauses that.
   *  - HOSTING with nothing on: a host who invited first and plays second is
   *    standing in their room - "Your groove · nothing playing yet", the deck
   *    seat, Now Playing openable - instead of a page with no strip at all
   *    (a start() from a profile with an idle deck used to land only a
   *    toast, because no Player mounted to answer the door).
   *
   * Leaving the room clears it. Not while this device mirrors another of
   * its own: that strip belongs to the device holding the seat. And a
   * follower hearing it here, over a deck that IS playing something of its
   * own, is left alone while the host has nothing on yet - there is a song
   * here and a transport for it, and nothing to follow.
   */
  const mirroring = current === null && remoteTrack !== null;
  const following = useMemo<FollowingRoom | null>(() => {
    if (!room || mirroring) return null;
    const receivedAt = room.receivedAt ?? Date.now();
    if (hosting) {
      if (current !== null) return null;
      return {
        id: room.id,
        hostName: room.hostName,
        memberCount: room.memberCount,
        hosting: true,
        mode: 'device',
        trackId: null,
        trackTitle: null,
        trackArtist: null,
        track: null,
        trackMissing: false,
        playing: false,
        positionMs: 0,
        receivedAt,
        controls: 0,
      };
    }
    if (!silent && roomTrack !== null) return null;
    if (!silent && current !== null && room.trackId == null) return null;
    return {
      id: room.id,
      hostName: room.hostName,
      memberCount: room.memberCount,
      hosting: false,
      mode: silent ? 'speaker' : 'device',
      trackId: room.trackId,
      trackTitle: room.trackTitle ?? roomTrack?.title ?? null,
      trackArtist: room.trackArtist ?? roomTrack?.artist ?? null,
      track: roomTrack,
      trackMissing: roomMissing,
      playing: room.playing,
      positionMs: room.positionMs,
      receivedAt,
      controls: room.controls ?? 0,
    };
  }, [
    room?.id,
    room?.hostName,
    room?.memberCount,
    room?.trackId,
    room?.trackTitle,
    room?.trackArtist,
    room?.playing,
    room?.positionMs,
    room?.receivedAt,
    room?.controls,
    hosting,
    silent,
    mirroring,
    roomTrack,
    roomMissing,
    current === null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the room's fields, not its identity: the poll hands over a fresh object every few seconds
  ]);
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
  if (!shown && !following) return null;
  return (
    <div className="appPlayer" data-hidden={hidden || undefined}>
      {/* The player walks the queue itself; it only reports where it
          landed, and `current` follows. */}
      <Player
        track={shown}
        queue={queue}
        upNext={upNext}
        onUpNextChange={onUpNextChange}
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
        following={following}
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
