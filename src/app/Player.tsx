import { useEffect, useRef, useState } from 'react';
import {
  AudioEqualizer,
  ContextMenu,
  IconButton,
  Lyrics,
  MenuItem,
  PlayerBar,
  Popover,
  createAnalyserMeter,
  useBeat,
  useLiveLevels,
  volumeAmplitude,
} from '@glacier/react';
import type { AnalyserMeter, LoudnessMeter, PlayerRepeat } from '@glacier/react';
import { AudioLines, Check, Disc3, Image as ImageIcon, Mic } from '@glacier/icons';
import { PluginSlot } from '../plugins/runtime.tsx';
import { SpinningDisc } from './SpinningDisc.tsx';
import { fetchLyrics, type TrackLyrics } from './lyrics.ts';
import { useLibrary } from './library.tsx';
import { useEqualizer } from './equalizer.tsx';
import { usePlayback } from './playback.tsx';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { VolumeControl, VOLUME_UNITY } from './VolumeControl.tsx';
import { loadAudioUrl, type Track } from './tauri.ts';
import { onCarPlayRemote, pushCarPlayNowPlaying } from './carplay.ts';
import { BeatWave } from './BeatWave.tsx';
import { initDockWave } from './dockWave.ts';

/**
 * Kevin MacLeod - 'Funky Chunk' (incompetech.com), CC BY 3.0, streamed from
 * Wikimedia Commons. A stand-in until the station feed is wired up.
 */
const TRACK_URL =
  'https://upload.wikimedia.org/wikipedia/commons/a/a2/Funky_Chunk_%28ISRC_USUAN1500054%29.mp3';

/** The track's cover, when the feed carries one. The stand-in does not. */
const TRACK_ART: string | null = null;

/**
 * The demo stream as a Track, for surfaces that want one while nothing from
 * the library is loaded - the lyrics lookup asks by title and artist, and the
 * strip is honestly playing this, not nothing.
 */
const DEMO_TRACK: Track = {
  path: TRACK_URL,
  title: 'Funky Chunk',
  artist: 'Kevin MacLeod',
  album: '',
  duration: null,
  addedAt: 0,
  artwork: null,
  genre: '',
  lyrics: '',
};

/** Where the fader starts. The element opens at full, so it is told this too. */
const INITIAL_VOLUME = 70;

/**
 * The fader's 0-100 read as a beat intensity. Loud lifts the bar higher, but the
 * response is floored well above zero so a quiet track still visibly moves - the
 * fader sets the ceiling, not whether the bar reacts at all. Muting, or a fader
 * on the floor, is the only thing that holds it still: nothing is coming out, so
 * nothing moves. The floor and ceiling both sit inside `SEEK_MAX_INTENSITY` (3).
 */
const beatIntensity = (volume: number, muted: boolean) =>
  muted || volume <= 0 ? 0 : Math.max(1.2, 0.28 * volume ** 0.398);

/**
 * The turntable ramp: how far the speed bends and how long the motor takes in
 * each direction. The floor sits at half speed - an octave is as far as a stop
 * needs to fall to read as one - and the rest of it is carried by a gain fade
 * on the audio clock, so the ear hears the pitch dive INTO silence.
 *
 * The bend is the graph's, not the element's: `playbackRate` is the media
 * engine's own resampler, re-tuned on every write and reset across a pause on
 * WebKit, which is why the deck used to glitch and then stop being audible at
 * all after the first stop. See `rampSpeed` in the kit's analyser meter.
 */
const RATE_FLOOR = 0.5;
const SPIN_UP_MS = 380;
const SPIN_DOWN_MS = 320;
/**
 * How fast the level comes back when the platter picks up. Short on purpose:
 * the music has to be simply there when the button is pressed, so that what is
 * heard afterwards is the pitch climbing rather than a fade-in. Matched to the
 * spin-up, the climb happens under a fade and neither the press nor the effect
 * lands - the button feels slow and the ramp cannot be heard at all.
 */
const SPIN_UP_FADE_MS = 90;
/**
 * The blink of silence a play pressed mid-brake pays to drop the deck's
 * backlog before climbing (see the catch branch of setPlayingState). Long
 * enough for the gain to truly reach zero before the line is snapped, short
 * enough to read as the platter being caught rather than a stutter.
 */
const CATCH_FLUSH_MS = 45;

/** How the strip's artwork square is worn: as a turning CD or the flat cover. */
type ArtView = 'cd' | 'cover';

const ART_VIEW_KEY = 'attackfm-art-view';

// The stored choice, defaulting to the disc; anything unrecognised also lands
// there rather than blanking the square.
function readArtView(): ArtView {
  try {
    return localStorage.getItem(ART_VIEW_KEY) === 'cover' ? 'cover' : 'cd';
  } catch {
    return 'cd';
  }
}

/**
 * The mic popover's inside: the track's lyrics, fetched when the panel first
 * opens (the popover mounts its panel per open, so the effect is the lazy
 * trigger) and cached across opens by the lyrics module. Synced lines light
 * with playback and seek on press; plain-only lyrics read as static text -
 * no position, so nothing lights, and no handler, so nothing pretends to be
 * a button; and the waits and the misses are the same surface, empty, saying
 * which of the two it is.
 */
function LyricsPanel({
  track,
  position,
  onSeek,
}: {
  track: Track;
  position: number;
  onSeek: (time: number) => void;
}) {
  const [lyrics, setLyrics] = useState<TrackLyrics | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchLyrics(track).then((found) => {
      if (!cancelled) setLyrics(found);
    });
    return () => {
      cancelled = true;
    };
  }, [track]);

  if (lyrics === null) return <Lyrics lines={[]} emptyLabel="Searching for lyrics…" aria-label="Lyrics" />;
  if (lyrics.synced) {
    return (
      <Lyrics
        lines={lyrics.synced}
        position={position}
        onLineSelect={(line) => onSeek(line.time)}
        aria-label="Lyrics"
      />
    );
  }
  if (lyrics.plain) {
    return (
      <Lyrics lines={lyrics.plain.map((text) => ({ time: 0, text }))} aria-label="Lyrics" />
    );
  }
  return <Lyrics lines={[]} aria-label="Lyrics" />;
}

/**
 * The station strip along the bottom of the window. The kit's PlayerBar owns
 * the layout and every control; this owns the audio element, keeps the two in
 * step, and walks the queue: the list the playing track was opened from, in
 * the order it was showing. Skips and the end of a track resolve their target
 * here, where the bar's shuffle and repeat toggles live, and the chosen track
 * is handed up through onTrackChange rather than loaded directly - the app
 * owns what is playing; this owns what comes next.
 */
export function Player({
  track,
  queue = [],
  onTrackChange,
  autoplay = true,
}: {
  track: Track | null;
  /** The tracks around the current one, in played order. Empty means no list. */
  queue?: Track[];
  /** Adopts the track a skip or the end of the current one advanced to. */
  onTrackChange?: (track: Track) => void;
  /**
   * Whether a newly handed track starts playing once loaded. Off for the
   * launch seed - the app opens with a song on the deck, not blaring - and
   * on from the first thing the user actually picks.
   */
  autoplay?: boolean;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  // The analyser tapping the element. Null until the first play, because an
  // AudioContext built before a user gesture starts suspended and, on WebKit,
  // never recovers.
  const [meter, setMeter] = useState<LoudnessMeter | null>(null);
  const [position, setPosition] = useState(0);
  // Read off the file rather than hardcoded, so the bar is honest before the
  // metadata lands.
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<PlayerRepeat>('off');
  const [volume, setVolume] = useState(INITIAL_VOLUME);
  const [muted, setMuted] = useState(false);

  // The strip is built from the music list, so there is nothing settled to show
  // until the folder is resolved and its files have been walked. The whole bar
  // loads as a skeleton until then.
  const { loading: libraryLoading, scanning, isFavorite, toggleFavorite, tracks: libraryTracks } = useLibrary();
  const listLoading = libraryLoading || scanning;
  // The heart reflects and toggles the current track's place in favourites.
  const favorite = track ? isFavorite(track.path) : false;

  // The artwork read fresh from the library rather than off the snapshot: a
  // rescan revokes every previous pass's object URLs, so a queue held across
  // one would show dead images. Looked up by path for display only - swapping
  // the snapshot objects themselves would re-key the load effect and restart
  // playback. A path no longer in the library keeps its snapshot art (and a
  // freshly cached row's null art falls back to the station mark downstream).
  const liveTrack = track ? libraryTracks.find((t) => t.path === track.path) : undefined;
  const artwork = liveTrack ? liveTrack.artwork : (track?.artwork ?? TRACK_ART);

  // Whether the square wears the disc or the flat cover; a right-click on it
  // offers the switch, and the choice persists like the rest of the app's
  // preferences.
  const [artView, setArtView] = useState<ArtView>(readArtView);
  const chooseArtView = (next: ArtView) => {
    setArtView(next);
    try {
      localStorage.setItem(ART_VIEW_KEY, next);
    } catch {
      // Storage unavailable - the choice still applies for this session.
    }
  };

  // The EQ gains ride the graph's filters; kept in a ref so a freshly built
  // meter can be seeded with them without waiting for a render.
  const { gains: eqGains, preset: eqPreset, setGains: setEqGains, setPreset: setEqPreset } = useEqualizer();
  const eqGainsRef = useRef(eqGains);
  eqGainsRef.current = eqGains;

  // What the element is playing. The demo stream until a library track is opened.
  const [src, setSrc] = useState(TRACK_URL);
  // The second deck's source: empty until the first crossfade borrows it.
  const [srcB, setSrcB] = useState<string | undefined>(undefined);
  // The playback settings: crossfade length, shuffle manners, what a pause
  // sounds like, and the sleep timer.
  const playback = usePlayback();
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  // Which of the two decks the transport answers to. A crossfade plays the
  // next track on the idle deck and, when the outgoing one ends, hands the
  // whole strip over to it - a ref, not state, because nothing rendered names
  // a deck: position and duration are state of their own, and the src states
  // above already know which element they feed.
  const audioBRef = useRef<HTMLAudioElement>(null);
  const activeIsB = useRef(false);
  const activeAudio = () => (activeIsB.current ? audioBRef.current : audioRef.current);
  const idleAudio = () => (activeIsB.current ? audioRef.current : audioBRef.current);
  const setIdleSrc = (url: string) => (activeIsB.current ? setSrc(url) : setSrcB(url));
  const setActiveSrc = (url: string) => (activeIsB.current ? setSrcB(url) : setSrc(url));
  // An element can back only one analyser source, so the meter is built once and
  // reused across tracks rather than rebuilt on every play.
  const analyserRef = useRef<AnalyserMeter | null>(null);
  // The element's seat at the graph's mixer, where crossfade levels live.
  // addSource caches per element, so asking every time is asking once.
  const seatOf = (el: HTMLAudioElement | null) =>
    el && analyserRef.current ? analyserRef.current.addSource(el) : null;
  // Read through refs so the volume can be (re)applied from stale play-time
  // closures without going through a fresh render first.
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Push the current fader onto whichever stage carries it. With the analyser
  // graph up, the element runs full (so the meter reads the whole signal) and
  // the gain after the analyser sets loudness; before it exists - in the browser
  // - the element carries the volume itself.
  // What the fader says playback should weigh right now, muting included.
  // Below unity it is calibrated in decibels; above it (100-150) a straight
  // amplitude boost the gain node can apply directly.
  const currentAmplitude = () =>
    mutedRef.current
      ? 0
      : volumeRef.current <= VOLUME_UNITY
        ? volumeAmplitude(volumeRef.current)
        : volumeRef.current / VOLUME_UNITY;

  const applyVolume = (vol = volumeRef.current, isMuted = mutedRef.current) => {
    const audio = activeAudio();
    const amplitude = isMuted ? 0 : vol <= VOLUME_UNITY ? volumeAmplitude(vol) : vol / VOLUME_UNITY;
    if (analyserRef.current) {
      analyserRef.current.setVolume(amplitude);
      // Both decks run full into the graph; their share of the mix is the
      // seats' business and loudness is the fader gain's.
      if (audioRef.current) audioRef.current.volume = 1;
      if (audioBRef.current) audioBRef.current.volume = 1;
    } else if (audio) {
      // The element's own volume caps at 1; the boost range only exists once
      // the gain node carries it.
      audio.volume = Math.min(1, amplitude);
    }
  };

  const ensureMeter = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!analyserRef.current) {
      analyserRef.current = createAnalyserMeter(audio);
      const read = analyserRef.current.meter;
      // Store the function itself: a bare setState(fn) is read as an updater and
      // would stash the reading, not the reader.
      setMeter(() => read);
      // Hand the fader to the gain now that it exists.
      applyVolume();
      // Seed the EQ filters with the stored curve, and the graph with the
      // sound settings in force.
      analyserRef.current.setEqGains(eqGainsRef.current);
      analyserRef.current.setDynamics(playbackRef.current.nightMode);
      analyserRef.current.setMono(playbackRef.current.mono);
    }
    // A context built off the play gesture starts suspended; wake it here, on a
    // real click, or the analyser (and playback through it) stays silent.
    void analyserRef.current.resume?.();
  };
  // Set when a track is opened so the element starts as soon as it can play.
  // Loading the file is async, so the play cannot ride the click directly; the
  // canplay that the new source fires is what starts it.
  const pendingPlay = useRef(false);
  // Read through a ref so the track-load effect can stay keyed on the track
  // alone while still honouring the autoplay in force at load time.
  const autoplayRef = useRef(autoplay);
  autoplayRef.current = autoplay;
  // The strip's own engagement latch: the app's autoplay flag only knows about
  // rows being picked, but pressing play or a skip on the strip is engagement
  // too - after either, a queue advance must keep the music going rather than
  // loading the next track as quietly as the launch seed did.
  const engaged = useRef(false);
  // True between a drag's first move and its release. While it holds, the element
  // is left alone and its time updates are ignored, so the thumb tracks the
  // pointer smoothly instead of fighting playback and repeated file seeks.
  const scrubbing = useRef(false);
  // True while a seek is muted-through: a media element does not jump clean -
  // it keeps sounding its already-decoded audio for a beat after currentTime
  // is written, then goes quiet while it decodes at the target. Silencing the
  // graph for exactly that stretch turns "a weird bit of the old spot, a gap,
  // then the new spot" into "silence, then the new spot" - the shape of an
  // instrument that heard you. Cleared by the element's own seeked event.
  const seekMuted = useRef(false);

  // `at` is where a hit lands on the bar, so ripples leave the playhead rather
  // than a fixed point.
  const progress = duration > 0 ? position / duration : 0;
  // The analyser now reads full-scale regardless of the fader, so the bar would
  // keep moving even while silenced; freeze it when muted or on the floor so
  // "nothing coming out" still reads as "nothing moving".
  const audible = playing && !muted && volume > 0;
  const beat = useBeat({ meter, active: audible, at: progress });

  // The dock icon: the brand mark, drawn and shipped once at boot. A dev
  // binary has no bundle icon of its own, so without this the Dock shows the
  // generic executable tile.
  useEffect(() => {
    void initDockWave();
  }, []);
  // Coming back to the window wakes the audio graph. The play press already
  // resumes a parked context, but audio that was ALREADY playing gets no
  // press when the OS interrupts the output behind an occluded window - so
  // the return itself is the gesture: refocus and becoming visible both
  // nudge the context, and a running one ignores it for free.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      void analyserRef.current?.resume?.();
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  // The waveform the bar fills in as the track plays, sampled from the same
  // meter the beat reads. Without it the bar has a beat to pulse but no levels
  // to animate to.
  const levels = useLiveLevels({ meter, progress, active: audible });

  // The header moves to the same reading the bar does. Published rather than
  // lifted: the audio graph hangs off this component's element and should stay
  // here, and everything upstream wants is the number coming out of it. The
  // track and the coarse position ride along for the hero's lyric words -
  // whole seconds, so the header re-renders by the line, not by the frame.
  const { publish } = useNowPlayingMotion();
  const coarsePosition = Math.floor(position);
  useEffect(() => {
    publish({ meter, audible, track: track ?? DEMO_TRACK, position: coarsePosition });
  }, [publish, meter, audible, track, coarsePosition]);

  // ── CarPlay / system now-playing ─────────────────────────────────────────
  //
  // The native side (carplay.m) owns MPNowPlayingInfoCenter and the remote
  // command center; this feeds it and obeys it. Pushes go out only on
  // discontinuities - track change, play/pause, seek - because iOS runs the
  // clock itself from position + rate; obeying happens through one mount-once
  // listener that reads the latest controls through a ref, since the control
  // functions below are rebuilt every render and the listener is not.
  const carPlayControls = useRef<{
    setPlaying: (next: boolean) => void;
    next: () => void;
    previous: () => void;
    seek: (to: number) => void;
  } | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;
  const playingLiveRef = useRef(playing);
  playingLiveRef.current = playing;
  // Where the last push left the clock, so a seek (a jump the extrapolated
  // clock cannot have made) is recognisable against ordinary playback.
  const carPlaySentPos = useRef(-10);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;
    void onCarPlayRemote((command) => {
      const controls = carPlayControls.current;
      if (!controls) return;
      if (command === 'play') controls.setPlaying(true);
      else if (command === 'pause') controls.setPlaying(false);
      else if (command === 'toggle') controls.setPlaying(!playingLiveRef.current);
      else if (command === 'next') controls.next();
      else if (command === 'previous') controls.previous();
      else if (command.startsWith('seek:')) {
        const to = Number(command.slice(5));
        if (Number.isFinite(to) && to >= 0) controls.seek(to);
      }
    }).then((stop) => {
      if (dead) stop();
      else unlisten = stop;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);

  // The discontinuities the extrapolated clock cannot cover: a new track, a
  // play or pause, a duration finally learned from metadata.
  useEffect(() => {
    if (!track) return;
    carPlaySentPos.current = positionRef.current;
    void pushCarPlayNowPlaying({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artUrl: artwork?.startsWith('http') ? artwork : '',
      duration,
      position: positionRef.current,
      playing,
      // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on identity, state, and length; position rides along
    });
  }, [track, playing, duration]);

  // Seeks: the coarse clock jumping further than a second of playback could
  // carry it. Scrubs land here through commitSeek's setPosition.
  useEffect(() => {
    if (!track) return;
    if (Math.abs(coarsePosition - carPlaySentPos.current) <= 2.5) {
      carPlaySentPos.current = coarsePosition;
      return;
    }
    carPlaySentPos.current = coarsePosition;
    void pushCarPlayNowPlaying({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artUrl: artwork?.startsWith('http') ? artwork : '',
      duration,
      position: coarsePosition,
      playing,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the jump detector runs on the clock alone
  }, [coarsePosition]);

  // Push EQ edits onto the live filters as they happen.
  useEffect(() => {
    analyserRef.current?.setEqGains(eqGains);
  }, [eqGains]);

  // The sound settings ride the graph the same way. Before the first gesture
  // there is no graph; ensureMeter seeds it with these on creation.
  useEffect(() => {
    analyserRef.current?.setDynamics(playback.nightMode);
  }, [playback.nightMode]);
  useEffect(() => {
    analyserRef.current?.setMono(playback.mono);
  }, [playback.mono]);

  // A blend already running answers to the settings too: repeat-one and an
  // end-of-track timer both promise that THIS track's end matters, so a fade
  // toward the next one is cancelled rather than allowed to outrank them.
  useEffect(() => {
    if (repeat === 'one' || playback.sleep === 'end-of-track') abortCrossfadeRef.current();
  }, [repeat, playback.sleep]);

  // The clock half of the sleep timer ('end of track' lives in the ended
  // handler instead). The last five seconds are a fade on the audio clock, so
  // sleep arrives as a settling rather than a cut; the pause itself goes
  // through the ordinary path, which quietly puts the level back for whoever
  // presses play tomorrow morning.
  useEffect(() => {
    const sleep = playback.sleep;
    if (!sleep || sleep === 'end-of-track') return;
    let fading = false;
    let expired = false;
    const check = () => {
      const remaining = sleep.at - Date.now();
      if (remaining <= 0) {
        // Expiry hands the silence to the pause path, which restores the
        // level itself once the element has stopped. The flag keeps this
        // effect's own teardown - which runs the instant setSleep lands -
        // from putting the volume back over a pause still in flight.
        expired = true;
        playback.setSleep(null);
        setPlayingState(false);
        return;
      }
      if (remaining <= 5000 && !fading) {
        fading = true;
        analyserRef.current?.rampVolume(0, remaining / 1000);
      }
    };
    check();
    const interval = window.setInterval(check, 500);
    return () => {
      window.clearInterval(interval);
      // Any other end to a fade this effect started - the timer cleared, a
      // new one armed over it, the player unmounting - hands the level back;
      // without this a re-armed timer would play its whole run at zero.
      if (fading && !expired) applyVolume();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the timer alone
  }, [playback.sleep]);

  // The element is the source of truth for time, so the strip follows it rather
  // than the other way round. Both decks are wired the same way and the guards
  // sort out whose word counts: the strip listens to the active deck, and the
  // idle one only speaks up while a crossfade is loading it (its canplay is
  // taken by the crossfade's own one-shot listener, not these).
  useEffect(() => {
    const decks = [audioRef.current, audioBRef.current].filter(
      (el): el is HTMLAudioElement => el !== null,
    );
    if (decks.length === 0) return;
    applyVolume(INITIAL_VOLUME, false);
    // The element always runs at its own speed: the deck's bend is the graph's
    // job now, so nothing here touches playbackRate and there is no pitch
    // preservation to switch off.
    const cleanups = decks.map((audio) => {
      const isActive = () => audio === activeAudio();
      const onTime = () => {
        if (!isActive()) return;
        if (!scrubbing.current) setPosition(audio.currentTime);
        // The crossfade watches the clock from here: the one place the active
        // deck's remaining time is always fresh.
        tickRef.current(audio);
      };
      const onMeta = () => {
        if (isActive()) setDuration(audio.duration || 0);
      };
      // Through the ref: this listener is bound once, the queue changes often.
      const onEnded = () => {
        if (isActive()) endedRef.current();
      };
      // A freshly loaded track starts here rather than at the click: the source is
      // set once through React, and this fires when that source is ready, so the
      // play is never interrupted by the src being reassigned mid-request.
      const onCanPlay = () => {
        if (!isActive() || !pendingPlay.current) return;
        pendingPlay.current = false;
        ensureMeter();
        // A fresh track opens at full speed and full voice, and any ramp still
        // in flight from the previous one is orphaned here - its end must not
        // pause, and its fade must not silence, a track it was never about. The
        // deck goes back to full speed with its lag dropped: a new track is not
        // where the last one's wind-down should still be running out.
        rampToken.current += 1;
        windingDown.current = false;
        analyserRef.current?.resetSpeed(1);
        // A fresh load also owns its seat outright - a crossfade abandoned
        // part-way must not leave the new track half-mixed.
        seatOf(audio)?.setLevel(1);
        applyVolume();
        setPlaying(true);
        // An autoplay the runtime refuses (a queue advance outside any gesture,
        // on a strict browser) rejects; the bar goes back to paused rather than
        // showing a play that is not happening.
        void audio.play().catch(() => setPlaying(false));
      };
      // A source that cannot load (a cached row whose file was deleted, say)
      // fires error and never canplay: without this the bar would stay showing
      // the previous track's play state forever, over silence.
      const onError = () => {
        if (!isActive() || !audio.error) return;
        pendingPlay.current = false;
        setPlaying(false);
      };
      // The other end of a muted-through seek: the element has landed and is
      // sounding the new position, so the graph fades back up - short, on the
      // audio clock, out of the silence the press bought. A brake in flight
      // keeps its fall (the flag just clears), and a paused element leaves
      // the gain for its next start to set, as every start does.
      const onSeeked = () => {
        if (!isActive() || !seekMuted.current) return;
        seekMuted.current = false;
        if (!audio.paused && !windingDown.current) {
          analyserRef.current?.rampVolume(currentAmplitude(), 0.05);
        }
      };
      audio.addEventListener('timeupdate', onTime);
      audio.addEventListener('loadedmetadata', onMeta);
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('canplay', onCanPlay);
      audio.addEventListener('error', onError);
      audio.addEventListener('seeked', onSeeked);
      return () => {
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('loadedmetadata', onMeta);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('canplay', onCanPlay);
        audio.removeEventListener('error', onError);
        audio.removeEventListener('seeked', onSeeked);
      };
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, []);

  // Build the analyser on the first interaction with the app so its AudioContext
  // is created inside a user gesture and starts running. A song opened from a
  // row click starts playing in an async handler, past the gesture; a context
  // built there is suspended on WebKit and the meter reads silence, so the seek
  // bar shows no intensity. Priming here means the graph is live before playback.
  useEffect(() => {
    const prime = () => ensureMeter();
    window.addEventListener('pointerdown', prime, { once: true });
    window.addEventListener('keydown', prime, { once: true });
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, []);

  // Opening a track points the active deck at its file; the canplay handler
  // above starts it. The object URL is revoked when the track changes so a long
  // session does not leak them.
  useEffect(() => {
    if (!track) return;
    // A track a crossfade already carried onto the other deck arrives here
    // pre-played: the handover flipped the decks and handed the track up, so
    // there is nothing to load - loading would start it over from the top.
    if (adoptedPath.current === track.path) {
      adoptedPath.current = null;
      return;
    }
    // Any fade still in flight is about tracks that are no longer next.
    abortCrossfadeRef.current();
    // The played trail, for shuffle manners and the DJ's memory.
    recentRef.current = [...recentRef.current.slice(-19), track.path];
    let cancelled = false;
    let created: string | null = null;
    void (async () => {
      const url = await loadAudioUrl(track.path);
      if (cancelled || !url) return;
      created = url;
      setPosition(0);
      // Aborted again here, not just at the effect's top: a blend can begin in
      // the gap the await opened, off the old track's last timeupdates.
      abortCrossfadeRef.current();
      pendingPlay.current = autoplayRef.current || engaged.current;
      setActiveSrc(url);
    })();
    return () => {
      cancelled = true;
      // Asset-protocol URLs are not object URLs; only a blob needs releasing.
      if (created?.startsWith('blob:')) URL.revokeObjectURL(created);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the track only
  }, [track]);

  // Which ramp is in charge. A new ramp bumps the token and the old one's
  // frames see they are stale and stand down, so mashing play/pause hands the
  // platter over mid-swing instead of two ramps fighting for the rate.
  const rampToken = useRef(0);
  // True while a pause is still winding the platter down. The ended handler
  // reads it: a track that runs out mid-descent was stopped by the user, not
  // finished, and must not advance the queue.
  const windingDown = useRef(false);

  /**
   * THE DECK'S ONE RULE, which every stop and start below is written against.
   *
   * The slowdown is a delay line lengthening: while the deck runs slow, the
   * graph is reading the element's past, and the line holds the difference -
   * up to a few hundred milliseconds of signal the ear has not heard yet. A
   * line of fixed length plays its contents at NORMAL speed, so that backlog
   * is a loaded spring: pause the element, put the volume back, and the spring
   * unwinds as a burst of full-speed audio from just before the stop.
   *
   * So: the backlog may only be dropped (`resetSpeed`) at a moment nothing
   * can be heard, every route into silence goes through `park` - the one
   * place that drops it after a stop - and no stop restores the gain. The
   * gain is the STARTS' to restore: each start opens at the level it wants,
   * and a park that put the gain back itself would be racing the element's
   * own pause, which takes a few milliseconds to actually go quiet.
   */

  /**
   * The stop's landing. Stops the element, then drops the deck's backlog while
   * its output cannot be heard: the gain is at zero for a brake or a fade, and
   * for a cut the leftover few milliseconds ARE the cut. The gain is left
   * where it is - see the rule above.
   */
  const park = (audio: HTMLAudioElement) => {
    windingDown.current = false;
    audio.pause();
    analyserRef.current?.resetSpeed(1);
  };

  /**
   * Runs the deck to `to` over `ms` and calls `done` when it lands, unless a
   * later ramp superseded it.
   *
   * The glide itself is one instruction to the audio graph, scheduled on the
   * audio clock and interpolated per sample - nothing here is stepped from
   * JavaScript. This used to walk the element's `playbackRate` sixty times a
   * second, which is what made the deck glitch: every write re-tunes the media
   * engine's resampler, and WebKit hands the rate back to its default across a
   * pause, so after the first stop there was nothing left to hear.
   *
   * The timer that remains only answers "is it over yet", which is when a
   * wind-down gets to stop the element. A timer rather than an animation
   * frame: a window the OS stops painting suspends rAF entirely, and a pause
   * that never arrives is a track that plays on behind a paused button.
   */
  const rampDeck = (to: number, ms: number, done?: () => void) => {
    const token = (rampToken.current += 1);
    const deck = analyserRef.current;
    const audio = activeAudio();
    if (deck) {
      deck.rampSpeed(to, ms / 1000);
    } else if (audio) {
      // No graph, no deck - so no pitch to bend. The element's own volume
      // carries the stop instead, which at least makes it a fade and not a cut.
      const from = audio.volume;
      const target = to < 1 ? 0 : Math.min(1, currentAmplitude());
      const start = performance.now();
      const step = () => {
        if (token !== rampToken.current) return;
        const t = Math.min(1, (performance.now() - start) / ms);
        audio.volume = from + (target - from) * t;
        if (t < 1) setTimeout(step, 1000 / 60);
      };
      step();
    }
    if (done) {
      setTimeout(() => {
        if (token === rampToken.current) done();
      }, ms);
    }
  };

  const setPlayingState = (next: boolean) => {
    const audio = activeAudio();
    setPlaying(next);
    if (!audio) return;
    const style = playbackRef.current.pauseStyle;
    if (next) {
      // Built here, inside the click on the strip's own play button. A play
      // the element refuses (its source in an error state) rolls the bar
      // back rather than showing a play that is not happening.
      ensureMeter();
      engaged.current = true;
      windingDown.current = false;
      if (style !== 'turntable') {
        // The plainer starts: the deck holds full speed - any lag a past
        // turntable stop left behind is dropped while nothing can be heard -
        // and the level either steps straight in or takes a short breath.
        rampToken.current += 1;
        if (audio.paused) analyserRef.current?.resetSpeed(1);
        if (style === 'fade' && analyserRef.current) {
          analyserRef.current.setVolume(0);
          analyserRef.current.rampVolume(currentAmplitude(), 0.25);
        } else {
          applyVolume();
        }
        void audio.play().catch(() => setPlaying(false));
        return;
      }
      // The platter spins up. Cold, from a park: the line is already empty,
      // the deck is set at the floor while nothing can be heard, and the
      // level comes straight back (90ms) while the pitch takes its time -
      // what is heard is the platter catching up, not the music fading in.
      if (!analyserRef.current) {
        applyVolume();
        void audio.play().catch(() => setPlaying(false));
        rampDeck(1, SPIN_UP_MS);
      } else if (audio.paused) {
        analyserRef.current.setVolume(0);
        analyserRef.current.resetSpeed(RATE_FLOOR);
        void audio.play().catch(() => setPlaying(false));
        analyserRef.current.rampVolume(currentAmplitude(), SPIN_UP_FADE_MS / 1000);
        rampDeck(1, SPIN_UP_MS);
      } else {
        // Caught mid-brake, still sounding. The obvious move - glide up from
        // wherever the fall reached, keeping the line's backlog for
        // continuity - is a ratchet: every brake and climb runs slow, so
        // each press-pair banks another fifth of a second, mashing walks the
        // line to its ceiling, and a pinned line is a dead effect playing
        // seconds behind its own seek bar. So the catch pays a blink of
        // silence instead: the gain dips out, the backlog is dropped while
        // nothing can be heard, and the climb starts cold from the floor -
        // the same sound as a start from park, just caught sooner. The dip
        // re-silences the gain itself, so a fader nudged inside it cannot
        // put the flush back under a live voice.
        const token = (rampToken.current += 1);
        analyserRef.current.rampVolume(0, CATCH_FLUSH_MS / 1000);
        window.setTimeout(() => {
          if (token !== rampToken.current || !analyserRef.current) return;
          analyserRef.current.setVolume(0);
          analyserRef.current.resetSpeed(RATE_FLOOR);
          analyserRef.current.rampVolume(currentAmplitude(), SPIN_UP_FADE_MS / 1000);
          rampDeck(1, SPIN_UP_MS);
        }, CATCH_FLUSH_MS);
      }
    } else {
      // A blend under way is a blend the pause outranks.
      abortCrossfade();
      // A pause also cancels any autoplay still pending for a slow-loading
      // track - the canplay that finally arrives must not override the user.
      pendingPlay.current = false;
      if (style === 'instant') {
        // The cut: no brake, no fade, and any ramp in flight orphaned. Still
        // parked, not merely paused: a style switched mid-session can land a
        // cut on a deck whose line still holds a turntable brake's backlog.
        rampToken.current += 1;
        park(audio);
        return;
      }
      if (style === 'fade') {
        // A short fall to silence on the audio clock, then the stop - the
        // token is how a play pressed mid-fall supersedes the pause. The
        // winding-down flag holds across the fall for the same reason it
        // does on the turntable: a track running out under it was stopped by
        // the user, and must not advance the queue past an explicit pause.
        const token = (rampToken.current += 1);
        if (analyserRef.current) {
          windingDown.current = true;
          analyserRef.current.rampVolume(0, 0.2);
          window.setTimeout(() => {
            if (token !== rampToken.current) return;
            park(audio);
          }, 220);
        } else {
          audio.pause();
        }
        return;
      }
      // The platter winds down first; only a ramp that ran to its end stops
      // the element (a play pressed mid-descent supersedes it). The pitch
      // only dives to half speed - engines render lower badly - while the
      // gain rides to zero sample-accurately; together they read as a stop.
      //
      // Here the two do share a stretch, and should: a level falling straight
      // spends most of its loudness in the last part of the brake, so the
      // pitch is still audibly falling the whole way down and the two land on
      // silence together. The brake is short - a stop the ear can follow, not
      // a press that takes half a second to answer.
      //
      // What runs `park` matters as much as what it does: the brake built the
      // deck's backlog, and parking is what keeps it from ever being heard as
      // the burst of full-speed audio it would otherwise unwind into.
      windingDown.current = true;
      analyserRef.current?.rampVolume(0, SPIN_DOWN_MS / 1000);
      rampDeck(RATE_FLOOR, SPIN_DOWN_MS, () => park(audio));
    }
  };

  /** Back to the top of the current track, keeping the playing state as is. */
  // The top is just a seek with a fixed destination, and it wants everything
  // a seek gets: the deck flush, the crossfade abort, the mute through the
  // element's jump. One path, one set of manners.
  const rewind = () => commitSeek(0);

  /**
   * The top of the current track, playing - for repeat-one and a one-track
   * wrap. A start like any other, so it carries a start's duties: any brake
   * still in flight is orphaned (its park must not stop the track this just
   * restarted), a parked deck's backlog is dropped before it can be heard,
   * the speed glides home if a brake had bent it, and the gain - which parks
   * leave wherever the stop's fall reached - is brought back up.
   */
  const rewindAndPlay = () => {
    rewind();
    const audio = activeAudio();
    if (!audio) return;
    // Same wake-up every other play path gets: after a long idle the context
    // is interrupted, and a restart pressed then must bring the sound back.
    ensureMeter();
    rampToken.current += 1;
    windingDown.current = false;
    if (audio.paused) analyserRef.current?.resetSpeed(1);
    analyserRef.current?.rampVolume(currentAmplitude(), SPIN_UP_FADE_MS / 1000);
    setPlaying(true);
    void audio.play().catch(() => setPlaying(false));
    // From full speed this glide is a flat line that builds no backlog, so it
    // costs nothing except when it is needed - a restart pressed mid-brake.
    rampDeck(1, SPIN_UP_MS);
  };

  // The trail of what has played, newest last. Shuffle manners and the DJ both
  // read it: a song just heard is the last thing either should reach for.
  const recentRef = useRef<string[]>([]);

  /**
   * The DJ's pick when the queue has nothing left to offer: another track from
   * the library that belongs after this one - same genre first, same artist
   * next, anything unplayed after that - avoiding whatever just played. Null
   * when the library cannot help (empty, or nothing but the current track).
   */
  const pickDj = (): Track | null => {
    if (!track || libraryTracks.length === 0) return null;
    const recent = new Set(recentRef.current.slice(-8));
    const pool = libraryTracks.filter((t) => t.path !== track.path && !recent.has(t.path));
    const candidates = pool.length > 0 ? pool : libraryTracks.filter((t) => t.path !== track.path);
    if (candidates.length === 0) return null;
    const genres = (value: string) =>
      value
        .toLowerCase()
        .split(/,\s*/)
        .filter(Boolean);
    const own = new Set(genres(track.genre));
    const sharedGenre =
      own.size > 0 ? candidates.filter((t) => genres(t.genre).some((g) => own.has(g))) : [];
    const sameArtist = candidates.filter((t) => t.artist === track.artist);
    const shortlist = sharedGenre.length > 0 ? sharedGenre : sameArtist.length > 0 ? sameArtist : candidates;
    return shortlist[Math.floor(Math.random() * shortlist.length)] ?? null;
  };

  /**
   * The step to the queue's next or previous track, as a value: the track to
   * hand up, `'rewind'` when the step lands back on the one playing (a
   * one-track wrap), or null when the honest answer is to stop. Both the ended
   * handler and the crossfade ask this - the crossfade has to know where the
   * music is going before it can start blending toward it.
   *
   * Shuffle picks any other track instead of the neighbour - avoiding a
   * back-to-back artist and the recent trail while it has the choice, when
   * smart shuffle is on. Off the end of the queue, the DJ takes over if asked.
   */
  const pickNext = (dir: 1 | -1, wrap: boolean): Track | 'rewind' | null => {
    if (!onTrackChange || queue.length === 0 || !track) return null;
    const index = queue.findIndex((t) => t.path === track.path);
    if (index === -1) {
      // The playing track left the queue (opened from elsewhere, or the DJ's
      // own pick). Forwards, the DJ carries on from it - or nobody does;
      // backwards there is no history to step into, so back means the top of
      // this track rather than a fresh random draw.
      if (dir === -1) return 'rewind';
      return playbackRef.current.autoDj ? pickDj() : null;
    }
    let nextIndex: number;
    if (shuffle && queue.length > 1) {
      // Any track but the one just played, so shuffle never repeats back-to-back.
      let pool = queue.map((t, i) => i).filter((i) => i !== index);
      if (playbackRef.current.smartShuffle) {
        // Prefer a change of artist, then an escape from the recent trail -
        // each only while it leaves any choice at all.
        const artist = track.artist;
        const offArtist = pool.filter((i) => queue[i]!.artist !== artist);
        if (offArtist.length > 0) pool = offArtist;
        const recent = new Set(recentRef.current.slice(-8));
        const fresh = pool.filter((i) => !recent.has(queue[i]!.path));
        if (fresh.length > 0) pool = fresh;
      }
      nextIndex = pool[Math.floor(Math.random() * pool.length)]!;
    } else {
      nextIndex = index + dir;
      if (nextIndex < 0 || nextIndex >= queue.length) {
        if (!wrap) {
          // Forwards off the end is where the DJ picks the needle up.
          return dir === 1 && playbackRef.current.autoDj ? pickDj() : null;
        }
        nextIndex = (nextIndex + queue.length) % queue.length;
      }
    }
    if (nextIndex === index) return 'rewind';
    return queue[nextIndex] ?? null;
  };

  /** Acts on the pick: hands the track up, replays, or stops. */
  const advance = (dir: 1 | -1, wrap: boolean) => {
    const next = pickNext(dir, wrap);
    if (next === null) {
      // The element too, not just the bar: reached from a skip as well as
      // from a natural end, and a skip's deck is still mid-song.
      activeAudio()?.pause();
      setPlaying(false);
      return;
    }
    if (next === 'rewind') {
      rewindAndPlay();
      return;
    }
    onTrackChange?.(next);
  };

  /**
   * The crossfade in flight, if any. The next track starts on the idle deck
   * under the end of the current one, the two seats counterslide, and when the
   * outgoing deck runs out the strip is handed to the incoming one whole -
   * already playing, mid-song, at full mix. Everything that would make the
   * blend a lie - a pause, a skip, a seek, a new track picked - aborts it.
   */
  const xfadeRef = useRef<{ next: Track; token: number; started: boolean } | null>(null);
  const xfadeToken = useRef(0);
  // The track a handover just delivered: the load effect must adopt it where
  // it stands rather than load it over from the top.
  const adoptedPath = useRef<string | null>(null);

  const abortCrossfade = () => {
    const flight = xfadeRef.current;
    if (!flight) return;
    xfadeToken.current += 1;
    xfadeRef.current = null;
    const idle = idleAudio();
    if (flight.started) {
      // Audible already: the outgoing seat takes the mix back, the incoming
      // one ducks out before it stops.
      seatOf(activeAudio())?.fadeLevel(1, 0.3);
      seatOf(idle)?.fadeLevel(0, 0.15);
    }
    // The stop is scheduled whether or not the blend was audible yet: a
    // play() still settling when the abort landed would otherwise leave the
    // idle deck running the whole next track at level zero - silent, but
    // decoding away under a player that says paused.
    window.setTimeout(() => {
      if (!xfadeRef.current) idle?.pause();
    }, 250);
  };
  const abortCrossfadeRef = useRef(abortCrossfade);
  abortCrossfadeRef.current = abortCrossfade;

  /** Starts the incoming deck the moment its file is ready, and the blend. */
  const beginCrossfade = (next: Track, token: number) => {
    void (async () => {
      const url = await loadAudioUrl(next.path);
      if (token !== xfadeToken.current || !url) return;
      const idle = idleAudio();
      const active = activeAudio();
      if (!idle || !active) return;
      const start = () => {
        if (token !== xfadeToken.current) return;
        const flight = xfadeRef.current;
        if (!flight || flight.token !== token) return;
        // A canplay for some other file (an abandoned load's, arriving late):
        // not ours to act on - re-arm and wait for the right one.
        if (idle.currentSrc !== url) {
          idle.addEventListener('canplay', start, { once: true });
          return;
        }
        const remaining = (active.duration || 0) - active.currentTime;
        // Too late to blend (a stall ate the window): let the natural ended
        // path advance instead.
        if (!Number.isFinite(remaining) || remaining < 0.6) {
          xfadeRef.current = null;
          return;
        }
        const span = Math.min(playbackRef.current.crossfade, remaining);
        seatOf(idle)?.setLevel(0);
        idle.currentTime = 0;
        idle
          .play()
          .then(() => {
            if (token !== xfadeToken.current) {
              // Superseded while the play was settling; stop unless a newer
              // flight has already claimed the deck for itself.
              if (!xfadeRef.current) idle.pause();
              return;
            }
            flight.started = true;
            seatOf(idle)?.fadeLevel(1, span);
            seatOf(active)?.fadeLevel(0, span);
          })
          .catch(() => {
            // A deck that will not start is not a blend; the ended path will
            // advance the plain way.
            if (token === xfadeToken.current) xfadeRef.current = null;
          });
      };
      // The idle deck may already hold this very file from an abandoned blend
      // moments ago - same src through React means no load and no canplay, so
      // a ready deck starts straight away rather than waiting for an event
      // that will never fire.
      const already = idle.src === url && idle.readyState >= 3;
      if (already) {
        start();
      } else {
        idle.addEventListener('canplay', start, { once: true });
        setIdleSrc(url);
      }
    })();
  };

  /** Watches the active deck's clock and opens the blend inside the window. */
  const crossfadeTick = (el: HTMLAudioElement) => {
    if (xfadeRef.current) return;
    // A load in flight means the deck under this timeupdate is already being
    // replaced: its remaining seconds belong to a track on its way out, and a
    // blend begun off them would fade the user's fresh pick down to nothing.
    if (pendingPlay.current) return;
    const settings = playbackRef.current;
    if (settings.crossfade <= 0) return;
    if (!analyserRef.current) return;
    if (!playing || windingDown.current || scrubbing.current) return;
    if (repeat === 'one') return;
    // A timer waiting on this track's end must get an end, not a segue.
    if (settings.sleep === 'end-of-track') return;
    const duration = el.duration;
    // Short files are all edges: a blend needs a middle to blend over.
    if (!Number.isFinite(duration) || duration < settings.crossfade + 8) return;
    const remaining = duration - el.currentTime;
    // A lead over the fade window covers the file's load time.
    if (remaining > settings.crossfade + 0.4 || remaining <= 0.5) return;
    const next = pickNext(1, repeat === 'all');
    if (next === null || next === 'rewind' || next.path === track?.path) return;
    // A pick shorter than the window would end while still fading in and
    // wedge the handover on a spent deck; the plain advance suits it better.
    if (next.duration !== null && next.duration < settings.crossfade + 2) return;
    const token = (xfadeToken.current += 1);
    xfadeRef.current = { next, token, started: false };
    beginCrossfade(next, token);
  };
  const tickRef = useRef(crossfadeTick);
  tickRef.current = crossfadeTick;

  // What the end of a track does: replay it under repeat-one, roll on
  // otherwise - wrapping only under repeat-all, so an unadorned queue plays
  // to its end and stops. Reached through a ref because the audio element's
  // listeners are bound once, and this closes over live queue and toggles.
  const handleEnded = () => {
    // A track that ran out while the pause ramp was still braking it was
    // stopped by the user, not finished: tidy the deck up and stay stopped
    // rather than looping or advancing past an explicit pause.
    if (windingDown.current) {
      // A park in all but the pause: the element ran itself out, so there is
      // nothing left to stop - just the backlog to drop while it is silent.
      // The gain stays down, as after any stop; the next start brings it up.
      windingDown.current = false;
      rampToken.current += 1;
      analyserRef.current?.resetSpeed(1);
      return;
    }
    // A crossfade already carried the next track in: the outgoing deck just
    // ran out under it, so the strip is handed over whole - the incoming deck
    // becomes the active one mid-song, and the track goes up to the app with
    // a note telling the load effect it is already playing.
    const flight = xfadeRef.current;
    if (flight?.started) {
      xfadeToken.current += 1;
      xfadeRef.current = null;
      activeIsB.current = !activeIsB.current;
      const nowActive = activeAudio();
      // Only a live deck is worth adopting: one that already ended (a pick
      // shorter than the blend) or errored would wedge the strip on silence.
      if (nowActive && !nowActive.ended && !nowActive.error) {
        seatOf(nowActive)?.setLevel(1);
        setPosition(nowActive.currentTime);
        setDuration(nowActive.duration || 0);
        setPlaying(true);
        adoptedPath.current = flight.next.path;
        recentRef.current = [...recentRef.current.slice(-19), flight.next.path];
        onTrackChange?.(flight.next);
        return;
      }
      // No deck to adopt (torn down mid-flight): fall through to the plain
      // advance below, which reloads the pick from the top.
      activeIsB.current = !activeIsB.current;
    }
    // The timer that asked for this very moment: stop here, tidily, rather
    // than rolling into the next track and past the listener's sleep.
    if (playbackRef.current.sleep === 'end-of-track') {
      playbackRef.current.setSleep(null);
      setPlaying(false);
      return;
    }
    // Repeat-all with nothing to advance through (the demo stream, a lone
    // track) loops the track itself, matching what repeat-one does beside it.
    if (repeat === 'one' || (repeat === 'all' && (!track || queue.length === 0))) {
      rewindAndPlay();
      return;
    }
    advance(1, repeat === 'all');
  };
  const endedRef = useRef(handleEnded);
  endedRef.current = handleEnded;

  // Manual skips always wrap: a button that dead-ends at the last row reads
  // as broken. Autoplay honours repeat instead (see handleEnded). With no
  // list to walk (the demo stream, a lone search hit) the handlers are not
  // offered and the kit leaves the buttons out.
  const canSkip = queue.length > 1 && !!onTrackChange && !!track;
  const skipForward = () => {
    engaged.current = true;
    // A skip is a decision about now; a blend toward some other track is not.
    abortCrossfade();
    advance(1, true);
  };
  const skipBack = () => {
    engaged.current = true;
    abortCrossfade();
    const audio = activeAudio();
    // Early in a track, back means the previous one; later it means the top
    // of this one - the convention every player shares.
    if (audio && audio.currentTime > 3) {
      rewind();
      return;
    }
    advance(-1, true);
  };

  // A drag only moves the thumb; writing the element's currentTime on every
  // move re-seeks the file and stutters. The element is set once, on release.
  const onScrub = (to: number) => {
    scrubbing.current = true;
    setPosition(to);
  };

  const commitSeek = (to: number) => {
    scrubbing.current = false;
    setPosition(to);
    // A seek re-earns the whole track - dragging back out of the fade window
    // must not leave a half-blended next track playing underneath it.
    abortCrossfade();
    // The deck's backlog is dropped WITH the jump, and before it: the line
    // holds the last beat of pre-seek signal, and left alone it would play
    // that first and then run behind the bar by its length - music trailing
    // the position it claims. A flush is a discontinuity, but so is the seek
    // itself, and one cut is what the ear was just promised.
    analyserRef.current?.resetSpeed(1);
    const audio = activeAudio();
    if (!audio) return;
    // Muted through the element's own seek (see seekMuted): the graph goes
    // silent BEFORE currentTime is written, so the stale decoded tail the
    // element sounds while it works is never heard, and the seeked event
    // fades the new position in. Only a playing, un-braking seek needs it -
    // paused seeks are silent already, and a brake owns its own fall.
    if (analyserRef.current && !windingDown.current && !audio.paused) {
      seekMuted.current = true;
      analyserRef.current.setVolume(0);
      // If seeked never lands (a source mid-error), the mute must not stick.
      window.setTimeout(() => {
        if (!seekMuted.current) return;
        seekMuted.current = false;
        const active = activeAudio();
        if (active && !active.paused && !windingDown.current) {
          analyserRef.current?.rampVolume(currentAmplitude(), 0.05);
        }
      }, 1200);
    }
    audio.currentTime = to;
  };

  // The car's handles on this player, refreshed every render so the listener
  // above always acts through current closures. Skips deliberately reuse the
  // strip's own handlers: a press on the steering wheel and a press on the
  // strip must do the identical thing, manners and all.
  carPlayControls.current = {
    setPlaying: setPlayingState,
    next: skipForward,
    previous: skipBack,
    seek: commitSeek,
  };

  // The fader no longer touches the element: it rides the gain after the
  // analyser, so turning down what you hear never turns down what the bar reads.
  //
  // While a stop is winding down, the fader keeps its state but the graph is
  // left alone: applyVolume would cancel the stop's scheduled fall and snap
  // the dying, pitch-bent music back to full voice - and the park behind it
  // would then cut and drop the deck's backlog in the open. The stop is
  // heading to silence whatever the fader says; the new level simply becomes
  // the one the next start opens at, which reads it from the ref.
  const setVolumeState = (next: number) => {
    setVolume(next);
    if (!windingDown.current) applyVolume(next, mutedRef.current);
  };

  const setMutedState = (next: boolean) => {
    setMuted(next);
    if (!windingDown.current) applyVolume(volumeRef.current, next);
  };

  return (
    <>
      {/* crossOrigin keeps the analyser readable: both the asset protocol and
          the remote demo are cross-origin but CORS-clean (the asset response
          carries ACAO for the window origin), so the graph reads real levels.
          A blob would be the one source to leave bare - but blobs are silent
          through WebKit's analyser, so the asset protocol is used instead. */}
      <audio ref={audioRef} src={src} crossOrigin="anonymous" preload="metadata" />
      {/* The second deck, silent until a crossfade borrows it - then the two
          alternate, whichever is idle catching the next track. Same CORS rule
          as its twin; preload=auto because when it has a src at all, that file
          is about to be needed inside a fade window. */}
      <audio ref={audioBRef} src={srcB} crossOrigin="anonymous" preload="auto" />
      <PlayerBar
        // The shell already insets the strip from the window edges, so it reads
        // as a plate lifted off the background rather than welded to the sill.
        position="floating"
        density="compact"
        // Until the list has loaded the strip stands as placeholders rather than
        // showing a track that is not settled yet.
        skeleton={listLoading}
        // The strip's artwork square wears the cover as a turning CD or as
        // the flat album art - a right-click on it offers the choice. A track
        // without art gets the station mark instead, so the square never
        // stands empty. The art itself is decorative: the title beside it
        // already names what is playing.
        artwork={
          <ContextMenu
            aria-label="Artwork style"
            className="artViewTarget"
            content={
              <>
                <MenuItem
                  icon={<Disc3 size={15} />}
                  shortcut={artView === 'cd' ? <Check size={14} /> : undefined}
                  onSelect={() => chooseArtView('cd')}
                >
                  Spinning CD
                </MenuItem>
                <MenuItem
                  icon={<ImageIcon size={15} />}
                  shortcut={artView === 'cover' ? <Check size={14} /> : undefined}
                  onSelect={() => chooseArtView('cover')}
                >
                  Album cover
                </MenuItem>
              </>
            }
          >
            {artView === 'cd' ? (
              <SpinningDisc
                art={artwork}
                spinning={audible}
                beat={beat}
                // The platter and the sound share a motor: the disc brakes and
                // catches up over the same stretch the audio does, whichever
                // stop the pause style buys - the turntable's ramp, the fade's
                // short fall, or the cut's plain halt.
                spinUpMs={
                  playback.pauseStyle === 'turntable'
                    ? SPIN_UP_MS
                    : playback.pauseStyle === 'fade'
                      ? 250
                      : 0
                }
                spinDownMs={
                  playback.pauseStyle === 'turntable'
                    ? SPIN_DOWN_MS
                    : playback.pauseStyle === 'fade'
                      ? 200
                      : 0
                }
              />
            ) : artwork ? (
              <img className="artViewCover" src={artwork} alt="" />
            ) : (
              <BeatWave className="artViewCover" beat={beat} />
            )}
          </ContextMenu>
        }
        title={track?.title ?? 'Funky Chunk'}
        subtitle={track?.artist ?? 'Kevin MacLeod'}
        duration={duration}
        value={position}
        onValueChange={onScrub}
        onSeekEnd={commitSeek}
        playing={playing}
        onPlayingChange={setPlayingState}
        // Skip moves between tracks in the list, not within the current one.
        onSkipBack={canSkip ? skipBack : undefined}
        onSkipForward={canSkip ? skipForward : undefined}
        shuffle={shuffle}
        onShuffleChange={setShuffle}
        repeat={repeat}
        onRepeatChange={setRepeat}
        favorite={favorite}
        onFavoriteChange={() => track && toggleFavorite(track.path)}
        // The mic sits just right of the heart, in the strip's leading rail:
        // the heart is how you feel about the song, the mic is the song's own
        // words. Synced lines light with playback and a press seeks to that
        // line - the seek goes through commitSeek, the same path the bar's
        // own scrubber lands on.
        leading={
          <Popover
            placement="top"
            aria-label="Lyrics"
            className="lyricsPopoverPanel"
            trigger={
              <IconButton variant="ghost" size="sm" aria-label="Lyrics" skeleton={listLoading}>
                <Mic size={16} />
              </IconButton>
            }
          >
            <div className="lyricsPopover">
              {/* Keyed by the track, so a change of song while the popover is
                  open tears the panel down whole: no window where the old
                  song's lines sit clickable over the new song's audio, and no
                  scroll position inherited from a sheet that no longer exists. */}
              <LyricsPanel
                key={(track ?? DEMO_TRACK).path}
                track={track ?? DEMO_TRACK}
                position={position}
                onSeek={commitSeek}
              />
            </div>
          </Popover>
        }
        levels={levels}
        beat={beat}
        // The equalizer and the custom volume fader share the trailing rail; the
        // kit's own volume is dropped (no volume props) since it stops at 100%.
        trailing={
          <>
            {/* Plugin controls lead the app's own EQ and fader, mirroring how
                the title bar seats plugins ahead of settings. Empty when none
                contribute. */}
            <PluginSlot id="player-trailing" />
            <Popover
              placement="top-end"
              aria-label="Equalizer"
              className="eqPopoverPanel"
              trigger={
                <IconButton variant="ghost" size="sm" aria-label="Equalizer">
                  <AudioLines size={16} />
                </IconButton>
              }
            >
              <div className="eqPopover">
                <AudioEqualizer
                  value={eqGains}
                  onValueChange={setEqGains}
                  preset={eqPreset}
                  onPresetChange={setEqPreset}
                />
              </div>
            </Popover>
            <VolumeControl
              value={volume}
              muted={muted}
              onValueChange={setVolumeState}
              onMutedChange={setMutedState}
            />
          </>
        }
        // The shadow trailing the beat under the played run; nothing is drawn
        // without a beat to trail, so it is safe to leave on.
        tracer
        // The bar moves as hard as the station is playing.
        intensity={beatIntensity(volume, muted)}
      />
    </>
  );
}
