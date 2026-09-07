import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { PlayerRepeat } from '@glacier/react';
import { trackIdFromPath } from '../server.ts';
import { VOLUME_MAX, VOLUME_UNITY } from './VolumeControl.tsx';
import { useConnect } from './playbackSync.tsx';
import { useJamOptional } from './jam.tsx';
import { usePlayback } from './playback.tsx';
import { recordDiag } from '../diag/diagLog.ts';
import { setNowPlayingBeat } from '../profile/presence.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { peekRoomTrack, resolveRoomTracks, roomTrack } from './roomTrack.ts';
import { deviceId } from './connect.ts';
import type { Track } from '../core/tauri.ts';
import type { JamCommand } from '../server.ts';

/** A member's command older than this is stale - the hub drops them at the
 *  same age, and a slow reply must not land a fifteen-second-old pause. */
const COMMAND_STALE_MS = 15_000;
/** How many applied commands are remembered, to refuse a second delivery. */
const COMMANDS_REMEMBERED = 64;

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
  /** Everything this device knows, for turning a hub track id into a row -
   *  books and unadopted auditions included. See library.tsx's `allTracks`:
   *  the music shelf is the wrong set to ask, because the other device may
   *  well be playing something that is not on it. */
  allTracks: Track[];
  onTrackChange: ((track: Track) => void) | undefined;
  onQueueChange: ((tracks: Track[]) => void) | undefined;
  /** Whether `track` is this device's own deck or a mirror of the one that
   *  holds playback - see the prop of the same name on Player. */
  deckOwned: boolean;
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
  commitSeek,
  setPlayingState,
  silent = false,
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
  commitSeek: (to: number) => void;
  setPlayingState: (next: boolean) => void;
  /** Following a groove on the host's SPEAKER: this deck stays silent, so the
   *  follow below must never take the room's song over. See PlayerHost. */
  silent?: boolean;
}): void {
  useEffect(() => {
    const findByConnectId = (id: number) =>
      liveRef.current.allTracks.find((t) => trackIdFromPath(t.path) === id) ?? null;
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
      /**
       * This device has just been handed the seat: load what the session is
       * playing, put it where the song actually is, and start it.
       *
       * The trap here is that `liveRef.current.track` is what the STRIP is
       * showing, not what this device's deck holds. A device that has only
       * ever been a remote is showing the hub's now-playing, mirrored out of
       * the library - so "the track already matches, just seek it" was true
       * of the picture and false of the audio. That path seeked a deck with
       * no source, started nothing, and - because it never handed the track
       * up - left the host's `current` null. The moment the state frame
       * flipped this device to active, the mirror it was mounted for went
       * away too, so PlayerHost tore the whole player down: no sound, and the
       * bar vanished. Handing back to the first device looked like a fix
       * because THAT device really did own its deck.
       *
       * So the fast path is gated on owning the deck, and every other route
       * goes through the same load-then-resume the app uses for any other
       * cross-track play.
       */
      becomeActive: (state) => {
        if (state.trackId == null) {
          recordDiag('connect', 'handed playback with no track in the session');
          return;
        }
        // The server froze the position at the moment of the hand-off; add the
        // little that has elapsed since (network + load) so playback resumes
        // where the song actually is, not a beat behind. Capped so a skewed
        // client clock can nudge but never fling the playhead.
        const elapsedMs = state.playing
          ? Math.min(15000, Math.max(0, Date.now() - state.updatedAt))
          : 0;
        const cur = liveRef.current.track;
        const sameTrack = cur != null && trackIdFromPath(cur.path) === state.trackId;

        // The seat can arrive carrying a position past the end of the song.
        // The hub counts the seconds between reports, and a device that went
        // quiet while holding the seat - loading, backgrounded, a speaker that
        // does not report - lets that count run past the last frame. Seeking
        // there is silence: the deck parks on the end and pauses, which is
        // exactly what "I can't pass it back" looked like. Past the end means
        // the song is over, so play it rather than sit on its final frame.
        const handed = state.positionMs + elapsedMs;
        const lenMs = ((sameTrack ? cur : findByConnectId(state.trackId))?.duration ?? 0) * 1000;
        const positionMs = lenMs > 0 && handed >= lenMs - 1000 ? 0 : Math.max(0, handed);

        // The seat carries the whole play context, not just the song. The hub
        // holds the queue for exactly this ("a transfer target can rebuild
        // it", connect.rs) and it was being dropped: the handed-to device got
        // one track and an empty list, so it played that song and stopped,
        // with its skip buttons dead. Anything the library cannot resolve is
        // left out rather than blanking a queue that is already right.
        const queued = (state.queue ?? [])
          .map(findByConnectId)
          .filter((t): t is Track => t != null);
        if (queued.length > 0) liveRef.current.onQueueChange?.(queued);

        // Already spinning this exact song on this device's own deck: a seek
        // is the whole hand-off, and reloading would restart it.
        if (sameTrack && liveRef.current.deckOwned) {
          liveRef.current.commitSeek(positionMs / 1000);
          liveRef.current.setPlayingState(!!state.playing);
          return;
        }

        const t = sameTrack ? cur : findByConnectId(state.trackId);
        if (!t) {
          // Nothing to play and the seat is held here, which is silence on
          // every device until someone moves it back. Worth a line in the
          // report rather than a shrug.
          recordDiag('connect', `handed playback of track ${state.trackId}, not in this library`);
          return;
        }
        resumeRef.current = { trackId: state.trackId, positionMs, play: !!state.playing };
        // A fresh object on purpose. When this device was mirroring, the host
        // is already rendering THIS track - passing it back unchanged is not a
        // state change, so the deck would never load it. The clone is what
        // makes the load effect run (and what gives the host a `current` of
        // its own, so it stops depending on the mirror to stay mounted).
        liveRef.current.onTrackChange?.({ ...t });
      },

      release: () => liveRef.current.setPlayingState(false),
    });
    return () => connect.registerController(null);
  }, [connect]);

  // What this device hears, for friends who may know (profile/presence.ts).
  // Song and play state only - the bridge decides whether it travels.
  useEffect(() => {
    setNowPlayingBeat(
      track ? { title: track.title, artist: track.artist, album: track.album ?? '', playing } : null,
    );
  }, [track, playing]);

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
  //
  // The reply carries the members' presses on the room's transport - a
  // follower's pause, next, seek - which this deck applies in order, as if
  // pressed here: the next beat carries the new state back out to everyone.
  // Each is remembered by its stamp so a second delivery (an interval that
  // overlapped a slow reply) cannot apply the same press twice, and one
  // older than the hub's own cut-off is let go.
  const applied = useRef<string[]>([]);
  // The hub, for the fold below: read through a ref so a session change
  // does not restart the beat.
  const { session } = useServerSession();
  const sessionRef = useRef(session);
  sessionRef.current = session;
  useEffect(() => {
    if (!jam?.current || !jam.hosting) return;
    // Cleared on teardown, so a fold or a reply that lands after the room
    // ended (or changed hands) touches nothing.
    let alive = true;
    const apply = (commands: JamCommand[]) => {
      const live = liveRef.current;
      const now = Date.now();
      const hubNow = jam.current?.now ?? null;
      for (const c of commands) {
        const key = `${c.at}\n${c.by}\n${c.action}\n${c.positionMs ?? ''}`;
        if (applied.current.includes(key)) continue;
        applied.current.push(key);
        if (applied.current.length > COMMANDS_REMEMBERED) applied.current.shift();
        // `at` is the hub's clock; measured against the hub's own `now` when
        // the room knows it, and against this device's otherwise (a skewed
        // phone can only make the cut-off looser, never drop a fresh one).
        // `at` is the hub's clock, so age it by the hub's clock when the room
        // carried one (read a poll earlier than now, which can only make the
        // cut-off looser, never drop a fresh press); the device's own clock is
        // the fallback, not a competitor - a phone running half a minute ahead
        // must not drop every press as stale.
        const age = hubNow != null ? hubNow - c.at : now - c.at;
        if (age > COMMAND_STALE_MS && c.at > 0) continue;
        switch (c.action) {
          case 'play':
            live.setPlayingState(true);
            break;
          case 'pause':
            live.setPlayingState(false);
            break;
          case 'toggle':
            live.setPlayingState(!live.playing);
            break;
          case 'next':
            live.skipForward();
            break;
          case 'prev':
            live.skipBack();
            break;
          case 'seek':
            if (typeof c.positionMs === 'number' && Number.isFinite(c.positionMs)) {
              live.commitSeek(Math.max(0, c.positionMs) / 1000);
            }
            break;
          default:
            break;
        }
      }
    };
    const beat = () => {
      const live = liveRef.current;
      const id = live.track ? trackIdFromPath(live.track.path) : null;
      void jam
        .hostBeat({
          trackId: id,
          trackTitle: live.track?.title ?? '',
          trackArtist: live.track?.artist ?? '',
          positionMs: Math.round(positionRef.current * 1000),
          playing: live.playing,
          deviceId: deviceId(),
          queue: live.queue
            .map((t: Track) => trackIdFromPath(t.path))
            .filter((n): n is number => n != null),
        })
        .then(({ additions, additionsNext, commands }) => {
          // Fold in what the room asked for, then the presses in the order
          // they were made - after the adds, so a "next" sent right behind
          // an add can land on it.
          void fold(additions, additionsNext).then(() => {
            if (alive && commands.length) apply(commands);
          });
        });
    };
    /**
     * A member's send, into this deck's line. Each id is resolved against
     * this library first and the hub second (roomTrack.ts - the same door
     * the deck's own surfaces use, so an id asked here is never asked
     * again): the library is scoped per member, and a guest can send a song
     * the host's shelf never listed - their own collector pull - which used
     * to be dropped on the floor here, the row silently missing from the
     * queue the guest was watching for it. Anything already queued is left
     * where it is. The rest lands where it was asked for: the play-next
     * sends go in right AFTER the song on, in the order they were asked
     * (the first asker's song plays first - one slice, not a run of
     * front-inserts), and the appends join the end of the line in ask
     * order; the next beat carries the grown queue back out to everyone.
     * An older hub sends no `additionsNext`, and the fold is the append it
     * always was. Only what the hub has never heard of is let go, and that
     * is said in the diag log.
     */
    const fold = (additions: number[], additionsNext: number[] = []): Promise<void> => {
      if (additions.length === 0 && additionsNext.length === 0) return Promise.resolve();
      const now = liveRef.current;
      const queued = new Set(now.queue.map((t: Track) => trackIdFromPath(t.path)));
      // A song asked for twice in one reply keeps its first ask of each
      // kind; asked for both ways, "next" is the ask that wins.
      // A "next" for a song ALREADY in the line is a move, not a no-op - so
      // the front list keeps queued ids; the row loop below pulls them up.
      const front = additionsNext.filter((aid, i) => additionsNext.indexOf(aid) === i);
      const back = additions.filter(
        (aid, i) => !queued.has(aid) && additions.indexOf(aid) === i && !front.includes(aid),
      );
      const wanted = [...front, ...back];
      if (wanted.length === 0) return Promise.resolve();
      return resolveRoomTracks(sessionRef.current, wanted, now.allTracks).then((rows) => {
        if (!alive) return;
        const deck = liveRef.current;
        const have = new Set(deck.queue.map((t: Track) => trackIdFromPath(t.path)));
        const soon: Track[] = [];
        const later: Track[] = [];
        const moved = new Set<string>();
        const curId = deck.track ? trackIdFromPath(deck.track.path) : null;
        rows.forEach((row, i) => {
          const aid = wanted[i]!;
          if (row === null) {
            recordDiag('jam', `a member sent #${aid}, which neither this library nor the hub has`);
            return;
          }
          if (!row) return;
          if (i < front.length && have.has(aid)) {
            // Already in the line: pull it up behind the song on (the song on
            // itself has nowhere to go). The row that is already queued is
            // the one that moves, so nothing about it is re-resolved.
            if (aid === curId) return;
            const standing = deck.queue.find((t: Track) => trackIdFromPath(t.path) === aid);
            if (!standing) return;
            moved.add(standing.path);
            soon.push(standing);
            return;
          }
          if (have.has(aid)) return;
          have.add(aid);
          (i < front.length ? soon : later).push(row);
        });
        if (soon.length === 0 && later.length === 0) return;
        // "Right after the song on" by the deck's own rule (App's playNext):
        // the slot after the current row; the end of the line when the song
        // on is not in it (the honest "next" with no known place to insert
        // after); the front when nothing is on at all - what plays first
        // once the host presses play.
        const cur = deck.track;
        const line = moved.size ? deck.queue.filter((t: Track) => !moved.has(t.path)) : deck.queue;
        const after = cur ? line.findIndex((t: Track) => t.path === cur.path) + 1 : 0;
        const at = !cur ? 0 : after === 0 ? line.length : after;
        deck.onQueueChange?.([...line.slice(0, at), ...soon, ...line.slice(at), ...later]);
      });
    };
    beat();
    const timer = window.setInterval(beat, 2500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [jam?.current?.id, jam?.hosting]);

  // Following: steer to the host. A different song loads and resumes at their
  // position (the same resumeRef the Connect hand-off uses); the same song
  // only corrects when it has drifted far enough to hear, since nudging the
  // playhead every few seconds is worse than a little slip.
  //
  // The position the server hands over was carried forward to the moment it
  // was READ; the time since then - the poll's flight plus however long the
  // frame sat before this ran - is added here, from this device's own clock
  // (receivedAt is stamped on arrival, so no cross-machine skew is involved).
  //
  // Hearing the room on the host's SPEAKER, none of this: the deck is silent
  // and stays silent, whatever the room moves to. The one thing the seam does
  // there is make sure of that. Keyed on `silent` as well, so the switch back
  // to hearing it HERE starts the audible follow from the room's clock at
  // once - and hands App a fresh object even when the deck already holds the
  // song, because the silent deck unloaded it and only a change of track
  // makes the load effect run (the same clone the Connect hand-off makes).
  const wasSilent = useRef(silent);
  useEffect(() => {
    const room = jam?.current;
    const live = liveRef.current;
    const wakingUp = wasSilent.current && !silent;
    wasSilent.current = silent;
    if (silent) {
      if (live.deckOwned && live.playing) live.setPlayingState(false);
      return;
    }
    if (!room || jam.hosting || room.trackId == null) return;
    const wanted = room.trackId;
    const currentId = live.track ? trackIdFromPath(live.track.path) : null;
    const sinceRead = room.playing && room.receivedAt ? Math.min(15_000, Math.max(0, Date.now() - room.receivedAt)) : 0;
    const roomMs = room.positionMs + sinceRead;

    // A deck this device does not own yet (PlayerHost stood the strip up on
    // the room's song for a guest with nothing playing) is taken over the
    // same way a different song is: handed to App as ours, with the host's
    // position applied once it has loaded.
    if (currentId !== wanted || !live.deckOwned || wakingUp) {
      // The song, wherever its row came from: the library's own, or the
      // hub's (roomTrack.ts). Both load the same way - `afm://<id>` is the
      // path either way, and the hub streams the id to any member - so the
      // hand-off below does not know which it was given. The room's clock
      // is re-read at the moment of the hand-off, since a fetched row may
      // arrive a beat after this effect ran.
      const takeOver = (t: Track) => {
        const now = liveRef.current;
        const since = room.playing && room.receivedAt ? Math.min(15_000, Math.max(0, Date.now() - room.receivedAt)) : 0;
        resumeRef.current = { trackId: wanted, positionMs: room.positionMs + since, play: room.playing };
        now.onTrackChange?.(wakingUp ? { ...t } : t);
      };
      const own = live.allTracks.find((x) => trackIdFromPath(x.path) === wanted);
      if (own) {
        takeOver(own);
        return;
      }
      // Not in this listener's library. That used to be the end of it - a
      // disc by name, no sound - but the listing is scoped per member while
      // the stream is not: a song promoted for the host alone is on this
      // hub and plays for this member the moment its row is known. So the
      // hub is asked for the row (once; the strip and the deck share the
      // answer), and only "the hub does not have it either" is the end.
      const lacks = (why: string) => {
        recordDiag('jam', `room is playing a song ${why}: ${room.trackArtist ?? ''} - ${room.trackTitle ?? ''} (#${wanted})`);
        // Whatever this deck was playing is not what the room is hearing, so
        // it stops rather than carrying on under a room that moved without
        // it. The strip shows the room by name from here (PlayerHost's
        // following state) and offers no transport for a song it lacks.
        const now = liveRef.current;
        if (now.deckOwned && now.playing) now.setPlayingState(false);
      };
      if (!session) {
        lacks('this library lacks (no hub to ask)');
        return;
      }
      const known = peekRoomTrack(session, wanted);
      if (known) {
        takeOver(known);
        return;
      }
      if (known === null) {
        lacks('neither this library nor the hub has');
        return;
      }
      // Only the latest run of this effect may act on the answer: a poll
      // that lands while the ask is in flight re-runs this and takes over
      // itself, and two hand-offs of one song would reload it.
      let current = true;
      roomTrack(session, wanted).then(
        (t) => {
          if (!current) return;
          if (t) takeOver(t);
          else lacks('neither this library nor the hub has');
        },
        () => {
          if (current) lacks('this library lacks, and the hub could not be asked');
        },
      );
      return () => {
        current = false;
      };
    }

    // A second and a half is the line: under it a nudge is more audible than
    // the slip; over it the two rooms are singing different bars.
    const driftSec = Math.abs(positionRef.current - roomMs / 1000);
    if (driftSec > 1.5) live.commitSeek(roomMs / 1000);
    if (live.playing !== room.playing) live.setPlayingState(room.playing);
    // Keyed on updatedAt so this runs once per report from the host rather
    // than on every render of this component.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jam?.current?.updatedAt, jam?.current?.trackId, jam?.hosting, silent]);

  // Apply a pending cross-track resume once the handed track has loaded.
  // Never on a silent deck: a resume left over from before the switch would
  // start the very sound the switch was made to stop.
  useEffect(() => {
    const r = resumeRef.current;
    if (silent) return;
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
      // The deck's length, so the hub's between-reports clock has a ceiling.
      // `duration` is this device's loaded deck; the library's number is the
      // fallback for the report that goes out before metadata lands.
      durationMs: Math.round((duration > 0 ? duration : (track.duration ?? 0)) * 1000),
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

}
