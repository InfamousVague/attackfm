import { useEffect, useState, type MutableRefObject } from 'react';
import type { PlayerRepeat } from '@glacier/react';
import { trackIdFromPath } from '../server.ts';
import { VOLUME_MAX, VOLUME_UNITY } from './VolumeControl.tsx';
import { useConnect } from './playbackSync.tsx';
import { useJamOptional } from './jam.tsx';
import { usePlayback } from './playback.tsx';
import type { Track } from '../core/tauri.ts';

type ConnectValue = ReturnType<typeof useConnect>;
type JamValue = ReturnType<typeof useJamOptional>;
type Playback = ReturnType<typeof usePlayback>;

/** The Player's live handlers and values, read through one ref so the
 *  once-registered controller always acts through the current render. */
export interface PlayerLiveState {
  playing: boolean;
  position: number;
  duration: number;
  track: Track | null;
  shuffle: boolean;
  repeat: PlayerRepeat;
  volume: number;
  queue: Track[];
  setPlayingState: (next: boolean) => void;
  skipForward: () => void;
  skipBack: () => void;
  commitSeek: (to: number) => void;
  setVolumeState: (next: number) => void;
  libraryTracks: Track[];
  onTrackChange: ((track: Track) => void) | undefined;
  onQueueChange: ((tracks: Track[]) => void) | undefined;
}

/** A cross-track "play here": the track is loaded via onTrackChange, then this
 *  remembered seek+play is applied once it has actually loaded. */
export type PendingResume = { trackId: number; positionMs: number; play: boolean } | null;

/**
 * The AttackFM Connect / jam seam, extracted from Player.tsx.
 *
 * This device is either the ACTIVE one (it plays and publishes state) or a
 * REMOTE (it mirrors what plays elsewhere and its controls send commands).
 * The seam is small on purpose: the controller below routes hub commands into
 * the same local handlers a tap would, and one effect republishes state on
 * each discontinuity. Off a server the provider is inert and all of this is
 * a no-op, so a lone device just plays.
 *
 * Every deck touch funnels through `liveRef` - the Player's own ref, passed
 * in whole so this hook never closes over a stale render.
 */
export function usePlayerConnect({
  connect,
  jam,
  liveRef,
  positionRef,
  playbackRef,
  resumeRef,
  track,
  playing,
  shuffle,
  repeat,
  volume,
  queue,
  seekTick,
  duration,
  remoteOnly,
  libraryTracks,
  commitSeek,
  setPlayingState,
}: {
  connect: ConnectValue;
  jam: JamValue;
  liveRef: MutableRefObject<PlayerLiveState>;
  positionRef: MutableRefObject<number>;
  playbackRef: MutableRefObject<Playback>;
  resumeRef: MutableRefObject<PendingResume>;
  track: Track | null;
  playing: boolean;
  shuffle: boolean;
  repeat: PlayerRepeat;
  volume: number;
  queue: Track[];
  seekTick: number;
  duration: number;
  remoteOnly: boolean;
  libraryTracks: Track[];
  commitSeek: (to: number) => void;
  setPlayingState: (next: boolean) => void;
}): {
  remoteTrack: Track | null;
  activeDeviceName: string | null;
  remotePosition: number;
} {
  useEffect(() => {
    const findByConnectId = (id: number) =>
      liveRef.current.libraryTracks.find((t) => trackIdFromPath(t.path) === id) ?? null;
    connect.registerController({
      play: () => liveRef.current.setPlayingState(true),
      pause: () => liveRef.current.setPlayingState(false),
      toggle: () => liveRef.current.setPlayingState(!liveRef.current.playing),
      next: () => liveRef.current.skipForward(),
      prev: () => liveRef.current.skipBack(),
      seek: (ms) => liveRef.current.commitSeek(ms / 1000),
      // A remote's fader obeys the same ceiling as the local one: without the
      // clamp a Connect command could push the gain past the boost cap (or to
      // arbitrary amplitudes) regardless of the setting.
      setVolume: (v) =>
        liveRef.current.setVolumeState(
          Math.max(0, Math.min(v, playbackRef.current.volumeBoost ? VOLUME_MAX : VOLUME_UNITY)),
        ),
      setQueue: (ids, index) => {
        // A remote picked a song (and the list it came from) for this active
        // device to play. Rebuild the whole play context from the library so
        // this device's own skips walk the new list, load the picked track,
        // and start it - the pick plays here, and the report that follows
        // changes the song on every device without moving audio control.
        const tracks = ids
          .map(findByConnectId)
          .filter((t): t is Track => t != null);
        const pick = tracks[index] ?? tracks[0];
        if (!pick) return;
        const pickId = trackIdFromPath(pick.path);
        if (tracks.length > 0) liveRef.current.onQueueChange?.(tracks);
        if (pickId != null) {
          resumeRef.current = { trackId: pickId, positionMs: 0, play: true };
        }
        liveRef.current.onTrackChange?.(pick);
      },
      becomeActive: (state) => {
        const cur = liveRef.current.track;
        if (state.trackId == null) return;
        // The server froze the position at the moment of the hand-off; add the
        // little that has elapsed since (network + load) so playback resumes
        // where the song actually is, not a beat behind. Capped so a skewed
        // client clock can nudge but never fling the playhead.
        const elapsedMs = state.playing
          ? Math.min(15000, Math.max(0, Date.now() - state.updatedAt))
          : 0;
        const positionMs = state.positionMs + elapsedMs;
        if (cur && trackIdFromPath(cur.path) === state.trackId) {
          liveRef.current.commitSeek(positionMs / 1000);
          liveRef.current.setPlayingState(!!state.playing);
          return;
        }
        const t = findByConnectId(state.trackId);
        if (t) {
          resumeRef.current = { trackId: state.trackId, positionMs, play: !!state.playing };
          liveRef.current.onTrackChange?.(t);
        }
      },

      release: () => liveRef.current.setPlayingState(false),
    });
    return () => connect.registerController(null);
  }, [connect]);

  // --- jams ---------------------------------------------------------------
  //
  // A jam is the same idea as a Connect hand-off, pointed at another PERSON
  // rather than another of your own devices: the host's deck is the clock and
  // everyone else steers to it. Two halves, and a device is only ever one of
  // them.
  //
  // Hosting: report where this deck is, on the room's own rhythm. The context
  // throttles the write, so this can afford to run on a plain interval and
  // stay ignorant of what has changed.
  useEffect(() => {
    if (!jam?.current || !jam.hosting) return;
    const beat = () => {
      const live = liveRef.current;
      const id = live.track ? trackIdFromPath(live.track.path) : null;
      void jam
        .hostBeat({
          trackId: id,
          positionMs: Math.round(positionRef.current * 1000),
          playing: live.playing,
          queue: live.queue
            .map((t: Track) => trackIdFromPath(t.path))
            .filter((n): n is number => n != null),
        })
        .then((additions) => {
          // Fold in what the room asked for. Resolve each id against this
          // library (host and members share the server's, so they land), drop
          // anything already queued, and append - the next beat carries the
          // grown queue back out to everyone.
          if (!additions.length) return;
          const now = liveRef.current;
          const have = new Set(now.queue.map((t: Track) => t.path));
          const add = additions
            .map((aid) => now.libraryTracks.find((t: Track) => trackIdFromPath(t.path) === aid))
            .filter((t): t is Track => !!t && !have.has(t.path));
          if (add.length) now.onQueueChange?.([...now.queue, ...add]);
        });
    };
    beat();
    const timer = window.setInterval(beat, 2500);
    return () => window.clearInterval(timer);
  }, [jam?.current?.id, jam?.hosting]);

  // Following: steer to the host. A different song loads and resumes at their
  // position (the same resumeRef the Connect hand-off uses); the same song
  // only corrects when it has drifted far enough to hear, since nudging the
  // playhead every few seconds is worse than a little slip. The position the
  // server hands over is already carried forward to the moment it was read.
  useEffect(() => {
    const room = jam?.current;
    if (!room || jam.hosting || room.trackId == null) return;
    const live = liveRef.current;
    const wanted = room.trackId;
    const currentId = live.track ? trackIdFromPath(live.track.path) : null;

    if (currentId !== wanted) {
      const t = live.libraryTracks.find((x) => trackIdFromPath(x.path) === wanted);
      // Not in this listener's library: nothing to play, so the room simply
      // moves on without them rather than the app inventing a track.
      if (!t) return;
      resumeRef.current = { trackId: wanted, positionMs: room.positionMs, play: room.playing };
      live.onTrackChange?.(t);
      return;
    }

    const driftSec = Math.abs(positionRef.current - room.positionMs / 1000);
    if (driftSec > 3) live.commitSeek(room.positionMs / 1000);
    if (live.playing !== room.playing) live.setPlayingState(room.playing);
    // Keyed on updatedAt so this runs once per report from the host rather
    // than on every render of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jam?.current?.updatedAt, jam?.current?.trackId, jam?.hosting]);

  // Apply a pending cross-track resume once the handed track has loaded.
  useEffect(() => {
    const r = resumeRef.current;
    if (!r || !track || duration <= 0) return;
    if (trackIdFromPath(track.path) !== r.trackId) return;
    commitSeek(r.positionMs / 1000);
    if (r.play) setPlayingState(true);
    resumeRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the load that satisfies the resume
  }, [track, duration]);

  // Publish this device's state to the hub on each discontinuity - but only
  // while it is the one playing (or already holds the seat). A mere app-open
  // never claims the seat; pressing play does, which is how playback starts
  // cold. Position is not a dep (the server extrapolates); seekTick stands in
  // for the one position jump extrapolation cannot follow.
  const ownsPlayback = connect.activeDeviceId === connect.thisDeviceId;
  const shouldReport = connect.connected && !!track && (playing || ownsPlayback);
  useEffect(() => {
    if (!shouldReport || !track) return;
    // Starting playback here while ANOTHER device holds the seat (a song picked
    // on a remote) claims it first: the hub only accepts state from the active
    // device, so without the claim the song would play here while the other
    // device kept playing too. The transfer releases (pauses) the other one.
    if (
      playing &&
      connect.activeDeviceId !== null &&
      connect.activeDeviceId !== connect.thisDeviceId
    ) {
      connect.transfer(connect.thisDeviceId);
    }
    const id = trackIdFromPath(track.path);
    connect.reportState({
      trackId: id,
      positionMs: Math.round(positionRef.current * 1000),
      playing,
      shuffle,
      repeat,
      volume,
      queue: queue
        .map((t) => trackIdFromPath(t.path))
        .filter((x): x is number => x !== null),
      queueIndex: Math.max(0, queue.findIndex((t) => t.path === track.path)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- discontinuities only; position rides refs
  }, [shouldReport, track, playing, shuffle, repeat, volume, seekTick]);

  // Playback lives on another device: this one is a remote. It shows that
  // device's now-playing (resolved from the library) and its transport sends
  // commands rather than driving local audio.
  const activeElsewhere = remoteOnly;
  const remoteTrack =
    activeElsewhere && connect.session?.trackId != null
      ? (libraryTracks.find((t) => trackIdFromPath(t.path) === connect.session!.trackId) ?? null)
      : null;
  const activeDeviceName =
    activeElsewhere
      ? (connect.devices.find((d) => d.id === connect.session?.activeDeviceId)?.name ?? 'another device')
      : null;

  // A remote's clock ticks locally between hub updates, extrapolated from the
  // last true position while the shared state says it is playing.
  const [, setRemoteTick] = useState(0);
  useEffect(() => {
    if (!activeElsewhere || !connect.session?.playing) return;
    const iv = window.setInterval(() => setRemoteTick((t) => t + 1), 1000);
    return () => window.clearInterval(iv);
  }, [activeElsewhere, connect.session?.playing, connect.session?.updatedAt]);
  const remotePosition = (() => {
    const s = connect.session;
    if (!s) return 0;
    const base = s.positionMs / 1000;
    // updatedAt is hub-clock; Date.now() is this device's. The skew stamp
    // (measured when the frame arrived) converts ours to theirs, so the
    // elapsed term no longer inherits whatever this phone's clock believes.
    const serverNow = Date.now() - (s.clockSkewMs ?? 0);
    return s.playing ? base + Math.max(0, (serverNow - s.updatedAt) / 1000) : base;
  })();

  return { remoteTrack, activeDeviceName, remotePosition };
}
