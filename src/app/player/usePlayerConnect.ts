import { useEffect, useRef, type MutableRefObject } from 'react';
import type { PlayerRepeat } from '@glacier/react';
import { soundFrame, type SoundAction } from './soundCommands.ts';
import type { ConnectCommand } from './connect.ts';
import { applyStemGains, setStemRelay } from './stemDrop.ts';
import { applyEffects, setEffectsRelay } from './effects.ts';
import { applyFxChain, setFxChainRelay } from './fxChain.ts';
import { trackIdFromPath } from '../server.ts';
import { VOLUME_MAX, VOLUME_UNITY } from './volume.ts';
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
  /** The hand-queued lane and the way to change it, so a remote's "add to
   *  queue" can land here without touching what is playing. */
  upNext: Track[];
  onUpNextChange: ((tracks: Track[]) => void) | undefined;
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
  upNext,
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
  /** The songs queued BY HAND. A separate lane from the context list, played
   *  before it - and the one a listener means by "the queue". */
  upNext: Track[];
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
      /*
       * A remote asked for songs to be added here. This is the other half of
       * the seat-holder's queue being shared: a device that is only watching
       * cannot edit its own lane usefully - nothing is playing there - so the
       * ask travels and lands on the deck that IS playing.
       *
       * Nothing about playback moves. That was the bug this exists to end:
       * "add to queue" on a watching phone fell into the local verb's
       * nothing-is-playing shortcut and started the song on the phone,
       * stealing the seat from the desktop mid-listen.
       */
      enqueue: (ids, next) => {
        const rows = ids.map(findByConnectId).filter((t): t is Track => t != null);
        if (rows.length === 0) return;
        const lane = liveRef.current.upNext;
        const fresh = rows.filter((t) => !lane.some((q) => q.path === t.path));
        if (fresh.length === 0) return;
        liveRef.current.onUpNextChange?.(next ? [...fresh, ...lane] : [...lane, ...fresh]);
      },
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

      /*
       * A remote moved the mix. The parts are taken out on the SERVER, on the
       * stream this device asked for, so this is the only device where the
       * change can be made to happen - which is why toggling karaoke on the
       * desktop while the phone was streaming did nothing at all.
       *
       * Committed to this device's own store, so the reload that carries the
       * new `drop` is the same one a local toggle causes, and the mixer here
       * reads the way the listener set it over there.
       */
      setStems: (gains) => applyStemGains(gains),

      /*
       * ...and the rack and the chain, which are the same sentence about a
       * different query parameter. `fx` and `fx2` are compiled by the encoder
       * on the stream THIS device asked for, so a filter tapped on the desktop
       * while the phone was streaming reached nothing at all - the phone's URL
       * was never re-spelled and the phone's connection was never re-opened.
       *
       * Committed to this device's own stores, so the reload that carries the
       * new sound is the one a local tap already causes: Player.tsx watches
       * both stores and re-colours in place, at the position the song is at.
       * There is no second code path here, which is why a remote's change
       * cannot restart the track when a local one does not.
       */
      setEffects: (ids) => applyEffects(ids),
      setChain: (nodes) => applyFxChain(nodes),

      release: () => liveRef.current.setPlayingState(false),
    });
    return () => connect.registerController(null);
  }, [connect, liveRef, playbackRef, resumeRef]);

  /*
   * THE OTHER END OF THE SOUND.
   *
   * While another device holds the seat this one is a remote, and anything
   * moved on the console here has to travel to reach the stream it applies
   * to. All three stores are wired in ONE effect because they are one fact:
   * this device is not the one making the sound. Registered on the stores
   * rather than on the surfaces that write them - there are seven of those
   * between the four rooms, the kill switches and the plugin host - so a new
   * surface travels by existing, and torn down the moment the seat comes back,
   * because a device driving its own deck must never send its own sound to
   * itself.
   *
   * The stores commit LOCALLY as well as sending, which is deliberate and is
   * the answer the mix already gave: the remote's own console should read the
   * way the listener just set it, and this device inherits the sound if it
   * later takes the seat back. It does NOT pull the seat holder's state the
   * other way - that would need the hub's session to carry the console as an
   * authoritative field, with an epoch of its own, and one answer across the
   * whole console beats two.
   */
  /*
   * NOT `connected`, which was the wire's opinion and not this device's.
   *
   * A socket blip took the relays down with it, so a filter tapped during one
   * was committed here, never sent, and never sent afterwards either - the two
   * ends then held different sounds permanently, with nothing on either screen
   * to say so. A remote is a remote whether or not its socket is up at this
   * instant; the store is the authority on what this device believes, and the
   * wire is a delivery problem. So the relays stay registered for as long as
   * another device holds the seat, and what could not go out is held below.
   */
  const remoting = connect.activeElsewhere;
  const carries = connect.carries;
  /**
   * What was moved on the console while the wire was down, per store.
   *
   * One slot each and the latest wins, which is the whole state a store has:
   * every frame carries the WHOLE of its own store, so the last one is not a
   * step in a sequence, it is the answer. Flushed on the next open, and
   * dropped the moment this device stops being a remote - by then it owns the
   * sound and has nowhere to send it.
   */
  const undelivered = useRef(new Map<SoundAction, ConnectCommand>());
  useEffect(() => {
    if (!remoting) {
      undelivered.current.clear();
      return;
    }
    /*
     * ONE relay per store, and only for the stores this hub says it carries
     * whole (see the `hello` frame in connect.ts). A hub that has not been
     * redeployed drops the payload and hands the playing device a bare action
     * it can only ignore - and, worse, spends on it the single slot it holds
     * for a seat-holder that is mid-blip, so a filter tapped there loses a
     * pause that was waiting to be delivered. There is nothing the client can
     * do to make such a hub carry the sound; what it can do is not put a frame
     * on a wire that will corrupt it. The change still applies here, and this
     * device inherits it if it takes the seat back.
     */
    const send = (command: ConnectCommand) => {
      if (connect.sendCommand(command)) undelivered.current.delete(command.action as SoundAction);
      else undelivered.current.set(command.action as SoundAction, command);
    };
    if (carries.has('stems')) setStemRelay((gains) => send(soundFrame('stems', gains)));
    if (carries.has('effects')) setEffectsRelay((ids) => send(soundFrame('effects', [...ids])));
    if (carries.has('chain')) setFxChainRelay((chain) => send(soundFrame('chain', chain)));
    return () => {
      setStemRelay(null);
      setEffectsRelay(null);
      setFxChainRelay(null);
    };
  }, [remoting, carries, connect]);

  /*
   * ...and the wire comes back.
   *
   * Only what was actually moved here while it was down is sent - never the
   * whole console on every reconnect, which would push this device's idea of
   * the sound at the seat holder every time a phone woke up, and is the same
   * mistake as pulling their state the other way.
   */
  useEffect(() => {
    if (!connect.connected || !remoting) return;
    const held = [...undelivered.current.values()];
    undelivered.current.clear();
    for (const command of held) {
      if (!connect.sendCommand(command)) undelivered.current.set(command.action as SoundAction, command);
    }
  }, [connect.connected, remoting, connect]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the jam's id and whether this device hosts it: `jam` itself is a fresh object on every poll, and re-running would restart the 2.5s beat.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Keyed on updatedAt so this runs once per report from the host rather than on every render of this component
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

  /*
   * A REMOTE MIRRORS THE SEAT HOLDER'S QUEUE.
   *
   * The hub has always carried the queue in its session, and this device has
   * always applied it in exactly one place: `becomeActive`, when the seat is
   * handed over. So a device merely WATCHING another one play showed its own
   * local queue - usually empty - and a song added on the active device never
   * appeared on it. Half the report was missing (above) and half the receiver
   * was missing; fixing either alone would still have looked broken.
   *
   * Keyed on the ids as a string rather than the array: the session is a fresh
   * object on every state frame (one a second while playing), and an array dep
   * would re-run this effect against an identical queue every time.
   *
   * Ids this library cannot resolve are dropped rather than blanking the list,
   * the same rule `becomeActive` uses - the other device may be playing
   * something this one has never seen. An all-unresolvable queue therefore
   * leaves what is here alone instead of emptying it.
   *
   * Never while `silent` (following a groove on somebody's speaker): that deck
   * is deliberately not taking the room's playback over, and its queue is not
   * this seam's to rewrite.
   */
  const isRemote =
    connect.connected &&
    connect.activeDeviceId !== null &&
    connect.activeDeviceId !== connect.thisDeviceId;
  const sharedQueueKey = isRemote ? (connect.session?.queue ?? []).join(',') : '';
  useEffect(() => {
    if (!isRemote || silent || sharedQueueKey === '') return;
    const rows = sharedQueueKey
      .split(',')
      .map((n) => Number(n))
      .map((id) => liveRef.current.allTracks.find((t) => trackIdFromPath(t.path) === id) ?? null)
      .filter((t): t is Track => t != null);
    if (rows.length === 0) return;
    const now = liveRef.current.queue;
    const same = now.length === rows.length && now.every((t, i) => t.path === rows[i]!.path);
    if (!same) liveRef.current.onQueueChange?.(rows);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the ids ARE the identity; the rest rides liveRef
  }, [isRemote, silent, sharedQueueKey]);

  // Publish this device's state to the hub on each discontinuity - but only
  // while it is the one playing (or already holds the seat). A mere app-open
  // never claims the seat; pressing play does, which is how playback starts
  // cold. Position is not a dep (the server extrapolates); seekTick stands in
  // for the one position jump extrapolation cannot follow.
  const ownsPlayback = connect.activeDeviceId === connect.thisDeviceId;
  const shouldReport = connect.connected && !!track && (playing || ownsPlayback);
  /*
   * The last song this device told the hub about.
   *
   * `positionRef` carries React state, and on a skip this effect runs in the
   * same commit as the new track - BEFORE the load effect has awaited its
   * source and called setPosition(0). So the report that goes out on a skip
   * said "new song, old song's position": skip four minutes into a track and
   * every watching device drew its bar four minutes in and ticked on from
   * there. Nothing corrected it either, because position is not a dep and no
   * further discontinuity was coming. That is the seek bar not lining up.
   */
  const reportedTrack = useRef<number | null>(null);
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
    /*
     * A song this device has not reported before is at its beginning, not
     * wherever the last one had got to - unless something asked for it at a
     * position (a resume, a hand-off, a bookmark), which is exactly what
     * `resumeRef` holds until the deck has loaded far enough to take it. Once
     * this song IS the reported one, the ref is honest again and speaks for
     * itself; `duration` below sends that second, settled word.
     */
    const fresh = reportedTrack.current !== id;
    const pending = resumeRef.current;
    const positionMs = fresh
      ? pending && pending.trackId === id
        ? Math.max(0, Math.round(pending.positionMs))
        : 0
      : Math.max(0, Math.round(positionRef.current * 1000));
    reportedTrack.current = id;
    // Where the playing song sits in the context, so the tail after it can be
    // appended behind the hand-queued lane. -1 when the song came from that
    // lane itself and was never in the context.
    const at = queue.findIndex((t) => t.path === track.path);
    connect.reportState({
      trackId: id,
      positionMs,
      // The deck's length, so the hub's between-reports clock has a ceiling.
      // `duration` is this device's loaded deck; the library's number is the
      // fallback for the report that goes out before metadata lands.
      durationMs: Math.round((duration > 0 ? duration : (track.duration ?? 0)) * 1000),
      playing,
      shuffle,
      repeat,
      volume,
      /*
       * WHAT WILL ACTUALLY PLAY, IN ORDER - which is not the context list.
       *
       * A song added with "Add to queue" or "Play next" goes into `upNext`,
       * a lane of its own that is consumed BEFORE the context (see pickNext).
       * This report only ever carried the context, so a song queued by hand
       * was never on the wire at all: it showed on the device that queued it
       * and could not reach any other, however many times the state was
       * republished. That is the whole of "the queue does not sync".
       *
       * So the wire carries the play order the listener would recite: what is
       * on now, then what they queued, then the rest of the list it came from.
       * A device handed the seat rebuilds exactly that order (becomeActive),
       * and a device merely watching can show it.
       */
      queue: (() => {
        // The hand-queued lane wins its songs. A track queued by hand is
        // usually still sitting in the context list at its own place, and
        // reporting both put it on the wire twice - measured: queueing Song 5
        // while its album played sent [6,5,7,8,4,5,2,3,1], and a watching
        // device would have drawn it twice in one list.
        const lane = new Set(upNext.map((t) => t.path));
        const tail = (at >= 0 ? queue.slice(at + 1) : []).filter((t) => !lane.has(t.path));
        return [track, ...upNext, ...tail]
          .map((t) => trackIdFromPath(t.path))
          .filter((x): x is number => x !== null);
      })(),
      // The playing track leads the list it reports, so its index is its head.
      queueIndex: 0,
    });
    /*
     * `queue` IS a discontinuity, and its absence here was the whole of "the
     * queue does not sync". Everything else a queue edit touches stays the
     * same - same song, same playing, same shuffle - so none of the other deps
     * changed and this effect never ran again. The report above has always
     * CARRIED the queue; it was simply never sent after the one that happened
     * to go out for some other reason. Adding a song on one device left the
     * hub holding the queue from the last track change.
     *
     * Safe as a dep because it is React state on the host, so its identity
     * changes only when somebody actually edits the queue - not per render and
     * never per position tick.
     */
    /*
     * `duration` is the deck becoming real: metadata has landed, the source is
     * loaded, and setPosition(0) (or the resume's seek) has already run. It is
     * the one moment after a track change when this device can speak for where
     * the song actually is, so the guess above gets a settled second word a
     * beat later rather than standing for the whole track.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps -- discontinuities only; position rides refs
  }, [shouldReport, track, duration, playing, shuffle, repeat, volume, seekTick, queue, upNext]);

}
