import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ContextMenu,
  IconButton,
  Lyrics,
  MenuItem,
  PlayerBar,
  Popover,
  SeekBar,
  createAnalyserMeter,
  useBeat,
  useLiveLevels,
  volumeAmplitude,
} from '@glacier/react';
import type { AnalyserMeter, LoudnessMeter, PlayerRepeat } from '@glacier/react';
import {
  AudioLines,
  Check,
  ChevronDown,
  ChevronLeft,
  Disc3,
  EyeOff,
  EllipsisVertical,
  Heart,
  Image as ImageIcon,
  ListMusic,
  ListPlus,
  Mic,
  MonitorSpeaker,
  Pause,
  Play,
  Repeat,
  Repeat1,
  Shuffle,
  SkipBack,
  SkipForward,
  Volume2,
} from '@glacier/icons';
import { isIOS, isMobile } from './platform.ts';
import { EqPanel } from './EqPanel.tsx';
import { PluginSlot } from '../plugins/runtime.tsx';
import { SpinningDisc } from './SpinningDisc.tsx';
import { fetchLyrics, type TrackLyrics } from './lyrics.ts';
import { useLibrary } from './library.tsx';
import { useEqualizer } from './equalizer.tsx';
import { usePlayback } from './playback.tsx';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { VolumeControl, VolumeRow, VOLUME_MAX, VOLUME_UNITY } from './VolumeControl.tsx';
import npPlaceholderArt from '../assets/attack-wave.png';
import { NowPlayingBackdrop } from './NowPlayingBackdrop.tsx';
import { useEffects } from './effects.ts';
import { loadAudioUrl, reactivateAudioSession, systemOutputVolume, type Track } from './tauri.ts';
import { notePlaybackAudible } from './autoCache.ts';
import {
  bindAudioFocus,
  bindNativeTransport,
  setNativeNowPlaying,
  setNativePlaybackState,
  setNativePlaying,
} from './androidAudio.ts';
import { isPendingPath } from './pendingPlay.tsx';
import { fetchCanvas, fetchPlayStates, isRemotePath, reportPlay, reportPosition, trackIdFromPath } from './server.ts';
import { fireNativeHaptic } from './haptics.ts';
import { createListenReporter, type ListenSnapshot } from './listens.ts';
import { loadScrubTape } from './scrubTape.ts';
import { useConnect } from './playbackSync.tsx';
import { DeviceList, DevicePicker, useDevicesAvailable } from './DevicePicker.tsx';
import { AddToPlaylistDialog } from './AddToPlaylist.tsx';
import { useServerSession } from './serverSession.tsx';
import { onCarPlayRemote, pushCarPlayNowPlaying, setIdleTimerDisabled } from './carplay.ts';
import { useJamOptional } from './jam.tsx';
import { QueuePanel } from './QueuePanel.tsx';
import { useSystemBack } from './systemBack.ts';
import {
  bindMediaSessionHandlers,
  updateMediaSessionMetadata,
  updateMediaSessionState,
} from './mediaSession.ts';
import { BeatWave } from './BeatWave.tsx';
import { usePlayerDismiss } from './playerDismiss.ts';
import { initDockWave } from './dockWave.ts';

/** No artwork for the blank idle stand-in, and the neutral fallback anywhere a
 *  cover is missing. */
const TRACK_ART: string | null = null;

/**
 * A blank stand-in for the surfaces that need a non-null Track while nothing is
 * loaded - the deck visuals key off `.path`, and publish() wants a shape. It is
 * deliberately empty and unplayable: an idle device must advertise "nothing,"
 * not a demo song, and there is no URL here for a stray play to ever start.
 */
const IDLE_TRACK: Track = {
  path: '',
  title: '',
  artist: '',
  album: '',
  duration: null,
  addedAt: 0,
  artwork: null,
  genre: '',
  lyrics: '',
};

/** Where the fader starts. The element opens at full, so it is told this too. */
/** Where a fresh install opens: unity, the same place the phone sits. Nothing
 *  is quieter than the file it is playing until somebody says so. */
const INITIAL_VOLUME = VOLUME_UNITY;

/** The deck's remembered dials - shuffle, repeat, the fader - one key each so
 * a bad value spoils only its own dial. */
function readDeckPref(name: string): string | null {
  try {
    return localStorage.getItem(`attackfm-deck-${name}`);
  } catch {
    return null;
  }
}

function writeDeckPref(name: string, value: string): void {
  try {
    localStorage.setItem(`attackfm-deck-${name}`, value);
  } catch {
    // Storage refused: the dial just resets next launch, as it always did.
  }
}

/**
 * The fader's 0-100 read as a beat intensity. Loud lifts the bar higher, but the
 * response is floored well above zero so a quiet track still visibly moves - the
 * fader sets the ceiling, not whether the bar reacts at all. Muting, or a fader
 * on the floor, is the only thing that holds it still: nothing is coming out, so
 * nothing moves. The floor and ceiling both sit inside `SEEK_MAX_INTENSITY` (3).
 *
 * `system` is the phone's own hardware level (0-1), applied AFTER the app's
 * graph - so it, not the in-app fader, is what says how loud the room actually
 * is. It scales the result on the same curve, which means turning the volume
 * buttons down calms the bar and turning them up drives it, and the two faders
 * compound the way the ear hears them. It is 1 wherever there is no separate
 * system fader to read (desktop, the browser), leaving the old behaviour
 * exactly as it was. Silenced hardware holds the bar still for the same reason
 * a muted app does: nothing is coming out.
 */
const beatIntensity = (volume: number, muted: boolean, system = 1) => {
  if (muted || volume <= 0 || system <= 0) return 0;
  // The app fader's own curve, untouched: ~1.76 wide open.
  const app = 0.28 * volume ** 0.398;
  // The device's own level, as a multiplier that sweeps nearly the whole way
  // down. An earlier pass floored this at 0.35, which left the bar swinging
  // between 1.75 and 0.90 across the entire hardware range - a difference you
  // have to measure rather than see. The small floor that remains keeps a bar
  // that is still audible from reading as dead; silence is handled above.
  // At system = 1 this is exactly 1, so anywhere without a separate hardware
  // fader (desktop, the browser) lands on the original number.
  const hardware = 0.12 + 0.88 * system ** 0.8;
  return app * hardware;
};

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

/** How the artwork is worn: a turning CD, the flat cover, or - on the big
 *  sheet - nothing at all, letting the canvas and the words have the room.
 *  The mini strip ignores 'hidden' and shows the cover: its square is also
 *  the tap target that lifts this sheet, and a hole in the strip reads as a
 *  layout bug, not a preference. */
type ArtView = 'cd' | 'cover' | 'hidden';

const ART_VIEW_KEY = 'attackfm-art-view';

// The stored choice, defaulting to the disc; anything unrecognised also lands
// there rather than blanking the square.
function readArtView(): ArtView {
  try {
    const stored = localStorage.getItem(ART_VIEW_KEY);
    return stored === 'cover' || stored === 'hidden' ? stored : 'cd';
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
/**
 * Tracks a media query as state. The player reshapes itself for touch - the
 * auxiliary controls fold behind one overflow button - and the same question
 * gates the CSS that grows the transport, so the query string is shared with
 * app.css rather than derived from the platform: a narrow desktop window
 * deserves the tidier bar too.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    // The resize listener repeats the question the mql should be answering:
    // some embedded webviews resize the viewport without dispatching mql
    // change events, and a phone never fires either (pointer: coarse holds),
    // so the duplicate costs nothing where it is not needed.
    window.addEventListener('resize', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, [query]);
  return matches;
}

/**
 * When the player folds its rails for touch. Kept beside the hook so the CSS
 * block in app.css quoting the same condition has one source to match.
 *
 * Coarse pointer is the real signal - a phone in any orientation, a tablet.
 * The width arm exists for browsers (previews included), and it stops at
 * 540px because the DESKTOP window can be as narrow as 560 (tauri.conf.json
 * minWidth): a squarish desktop window must never inherit the phone's bar.
 */
const MOBILE_PLAYER_QUERY = '(pointer: coarse), (max-width: 540px)';

export function Player({
  track,
  queue = [],
  onTrackChange,
  onQueueChange,
  onOpenArtist,
  autoplay = true,
  allowDock = true,
}: {
  track: Track | null;
  /** The tracks around the current one, in played order. Empty means no list. */
  queue?: Track[];
  /** Adopts the track a skip or the end of the current one advanced to. */
  onTrackChange?: (track: Track) => void;
  /** Replaces the play context - used when a remote hands this (active) device
   *  a whole new queue to play through, not just a single track. */
  onQueueChange?: (tracks: Track[]) => void;
  /** Opens an artist's page - the Now Playing sheet's artist line links
   *  through here, closing the sheet as it goes. */
  onOpenArtist?: (artist: string) => void;
  /** Whether the wide-screen docked sheet may mount. The host turns this off
   *  while the strip is only mirroring a remote device's playback. */
  allowDock?: boolean;
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
  // Shuffle, repeat, and the fader survive a relaunch the way every other
  // playback preference does - a player that forgets its own dials every
  // morning reads as broken, not fresh.
  const [shuffle, setShuffle] = useState(() => readDeckPref('shuffle') === 'on');
  const [repeat, setRepeat] = useState<PlayerRepeat>(() => {
    const saved = readDeckPref('repeat');
    return saved === 'all' || saved === 'one' ? saved : 'off';
  });
  // The phone opens at unity and stays there: hardware buttons are the volume
  // control a phone already has, so the app-side fader would only fight them.
  // Desktop keeps its calibrated fader, restored from the last session.
  const [volume, setVolume] = useState(() => {
    // Every phone, not just iOS: the hardware buttons are the volume
    // control a handset already has, and a second fader in the app only
    // fights them - two places to be quiet, one of which the user cannot
    // see while the screen is off. Pinned at unity so the OS mixer is the
    // only thing between the file and the speaker.
    if (isMobile) return VOLUME_UNITY;
    // The absent-key check must come before Number(): Number(null) is 0, which
    // would pass the range guard and open every fresh install silent.
    const raw = readDeckPref('volume');
    if (!raw) return INITIAL_VOLUME;
    const saved = Number(raw);
    return Number.isFinite(saved) && saved >= 0 && saved <= 150 ? saved : INITIAL_VOLUME;
  });
  const [muted, setMuted] = useState(false);

  // Written on change rather than on quit - there is no reliable "on quit".
  useEffect(() => writeDeckPref('shuffle', shuffle ? 'on' : 'off'), [shuffle]);
  useEffect(() => writeDeckPref('repeat', repeat), [repeat]);
  useEffect(() => {
    if (!isMobile) writeDeckPref('volume', String(Math.round(volume)));
  }, [volume]);

  // The strip is built from the music list, so there is nothing settled to show
  // until the folder is resolved and its files have been walked. The whole bar
  // loads as a skeleton until then.
  const { loading: libraryLoading, scanning, isFavorite, toggleFavorite, tracks: libraryTracks } = useLibrary();
  // The listening room this device is in, if any. Optional: the Player also
  // renders in trees without the provider.
  const jam = useJamOptional();
  const connect = useConnect();
  // True when the music is on ANOTHER device: this one is a remote. Read up
  // here because the audio loader below has to consult it - a remote must
  // never fetch the file it is not playing, which on a phone would be a whole
  // track pulled over the network for nothing.
  const remoteOnly =
    connect.connected &&
    connect.session?.activeDeviceId != null &&
    connect.session.activeDeviceId !== connect.thisDeviceId;
  const remoteOnlyRef = useRef(remoteOnly);
  remoteOnlyRef.current = remoteOnly;
  const listLoading = libraryLoading || scanning;
  // A placeholder for a tapped song still downloading (see pendingPlay.tsx): its
  // path names an import job, not a file. The load path skips it, and the sheet
  // shows it "Downloading…" until the real track swaps in and plays.
  const downloading = track ? isPendingPath(track.path) : false;
  // The heart reflects and toggles the current track's place in favourites.
  const favorite = track ? isFavorite(track.path) : false;
  // Hearting a song answers in the hand - the success triplet, only on the
  // way IN. Un-hearting stays silent: taking something back is not a fanfare.
  const toggleFavoriteFelt = () => {
    if (!track) return;
    if (!favorite) fireNativeHaptic('success');
    toggleFavorite(track.path);
  };

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
  // One menu, three doorways: the strip's square, the sheet's art, and the
  // Canvas clip itself all open this same chooser, so the setting stays one
  // setting no matter where the press lands.
  const npArtMenu = (
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
      <MenuItem
        icon={<EyeOff size={15} />}
        shortcut={artView === 'hidden' ? <Check size={14} /> : undefined}
        onSelect={() => chooseArtView('hidden')}
      >
        Hidden
      </MenuItem>
    </>
  );

  // The EQ gains ride the graph's filters; kept in a ref so a freshly built
  // meter can be seeded with them without waiting for a render.
  // Only the GAINS matter here now - the panel owns preset selection.
  const { gains: eqGains } = useEqualizer();
  const eqGainsRef = useRef(eqGains);
  eqGainsRef.current = eqGains;

  // On touch (or squeezed) the trailing rail folds to one overflow button and
  // the freed width goes to the transport, which app.css grows to thumb size
  // under the same query.
  const mobileControls = useMediaQuery(MOBILE_PLAYER_QUERY);
  // A screen wide enough to give Now Playing the right half for keeps -
  // an unfolded foldable, a tablet. The sheet stops being a destination you
  // lift and becomes a room that is simply always there; the rest of the app
  // lives in the left pane (appWindow shrinks by --np-dock-width, app.css).
  const npWide = useMediaQuery('(min-width: 700px)');
  const npDocked = mobileControls && npWide && allowDock;
  // The overflow popover opens on a chooser - Equalizer, Lyrics, Volume -
  // and each pick swaps the panel in behind a back row. Controlled, so every
  // open starts back at the chooser rather than wherever the last visit left
  // off.
  const [moreOpen, setMoreOpen] = useState(false);
  // 'lyrics' and 'volume' are the phone's views; 'devices' is the desktop's -
  // one state serves both because only one trailing branch renders at a time.
  const [moreView, setMoreView] = useState<'menu' | 'eq' | 'lyrics' | 'volume' | 'devices'>('menu');
  // Whether the overflow offers the device hand-off row at all.
  const devicesAvailable = useDevicesAvailable();
  // The song being filed into a playlist, or null when that sheet is shut.
  const [filing, setFiling] = useState<Track | null>(null);
  // The full-screen Now Playing surface, opened by tapping the strip on touch.
  const [npOpen, setNpOpen] = useState(false);
  // The playing track's Spotify Canvas (a short looping clip), when the server
  // is set up to fetch one and the track has one. Null the rest of the time,
  // and on every track change until the next answer lands, so a clip never
  // lingers over the wrong song. Only fetched while the full sheet is open.
  const [npCanvas, setNpCanvas] = useState<string | null>(null);
  // The lyrics, opened over the Now Playing sheet as a full-screen view rather
  // than a popover anchored to the bottom rail (which sat too low).
  const [npLyrics, setNpLyrics] = useState(false);
  // The queue, opened over the same sheet the same way: what plays next, and
  // draggable into any order.
  const [npQueue, setNpQueue] = useState(false);
  // A system back swipe (Android) peels these in the order they opened: the
  // queue or lyrics panel first, then the sheet itself, before the gesture is
  // allowed anywhere near the page history underneath.
  useSystemBack(npQueue, () => setNpQueue(false));
  useSystemBack(npLyrics, () => setNpLyrics(false));
  useSystemBack(npOpen, () => setNpOpen(false));
  // The Spotify move: while this sheet is up and the music is going, the phone
  // must not lock - but a screen at full brightness all song long is rude, so
  // after a quiet half-minute the sheet pulls a near-black veil over itself.
  // Any touch lifts it. Paused or closed, the OS idle timer is handed back and
  // the phone dims and locks like it always did.
  const [npDimmed, setNpDimmed] = useState(false);
  const npDimTimer = useRef<number | null>(null);
  const pokeNpDim = () => {
    if (npDimTimer.current !== null) window.clearTimeout(npDimTimer.current);
    npDimTimer.current = window.setTimeout(() => setNpDimmed(true), 30_000);
  };
  // A bad merge once swallowed the lock-screen effect INTO this callback -
  // hooks inside an effect body, an invalid-hook crash the moment it ran, and
  // the whole app went black on play. The lock-screen effect lives further
  // down now (it needs `audible`, which does not exist yet up here).
  const keepAwake = npOpen && playing;
  useEffect(() => {
    void setIdleTimerDisabled(keepAwake);
    if (!keepAwake) {
      if (npDimTimer.current !== null) {
        window.clearTimeout(npDimTimer.current);
        npDimTimer.current = null;
      }
      setNpDimmed(false);
      return;
    }
    pokeNpDim();
    return () => {
      if (npDimTimer.current !== null) {
        window.clearTimeout(npDimTimer.current);
        npDimTimer.current = null;
      }
      void setIdleTimerDisabled(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pokeNpDim only touches refs
  }, [keepAwake]);
  // Bumped on every seek so the Connect report effect refires (a seek moves the
  // clock without changing play/track). A ref mirrors it for closures.
  const [seekTick, setSeekTick] = useState(0);
  const seekEpoch = useRef(0);
  // Portrait thins the equalizer to five bands; a phone turned landscape has
  // the width for all eight again.
  const narrowEq = useMediaQuery('(max-width: 600px)');

  // What the element is playing. Empty until a library track is opened - it must
  // never sit pointed at the demo stream, or a device that has not opened
  // anything (a fresh launch, or one just handed the active seat on a Connect
  // switch) would start playing "Funky Chunk" the moment a play command lands.
  const [src, setSrc] = useState('');
  // The second deck's source: empty until the first crossfade borrows it.
  const [srcB, setSrcB] = useState<string | undefined>(undefined);
  // The playback settings: crossfade length, shuffle manners, what a pause
  // sounds like, and the sleep timer.
  const playback = usePlayback();
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  // Switching the boost range off pulls a fader parked above unity back to it;
  // the effect itself lives below setVolumeState, which it must go through so
  // the audible gain drops with the fader rather than at the next pause.
  const volumeBoost = playback.volumeBoost;
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

  // --- running dry -----------------------------------------------------------
  //
  // Streaming a lossless file over a phone's radio means about a megabit a
  // second, sustained, and a lift or a weak cell takes that away for a moment.
  // Nothing here used to notice: only six media events were bound, none of them
  // the ones that fire when the buffer runs out, so an underrun left `paused`
  // false, stopped `timeupdate`, and played silence under a transport still
  // showing play. Every transient hiccup became a permanent stop.
  //
  // So: notice it, say so, and put the deck back on its feet without letting
  // the ear hear a seam. Recovery re-resolves the source and seeks back to
  // where the music actually was - a fresh request, because the connection that
  // stalled is precisely the one not worth waiting on.

  /** True while the active deck has run dry. Drives the "Buffering" line. */
  const [buffering, setBuffering] = useState(false);
  /** When the clock stopped moving, or 0 when it is moving. */
  const stalledAt = useRef(0);
  /** The last position the deck reported, to resume to. */
  const lastGoodPos = useRef(0);
  /** Reloads spent on THIS track, reset whenever the listener moves. */
  const resumeCount = useRef(0);
  /** Bumped per reload so a re-resolved URL is never byte-identical: an
   *  unchanged src is a no-op through React, and the stalled connection's
   *  partial may itself be what is poisoned. */
  const resumeNonce = useRef(0);
  const recoverTimer = useRef<number | undefined>(undefined);

  /** How long a frozen clock is tolerated before reaching for the source. */
  const STALL_GRACE_MS = 1600;
  /** Waits between reloads, then giving up honestly. */
  const RETRY_BACKOFF_MS = [400, 1500, 4000];
  const MAX_RELOADS_PER_TRACK = 3;

  /** The warning buzz's visible half: whichever transport is on screen - the
   *  sheet's or the strip's - takes a short sideways jolt when playback gives
   *  up, so a stop the pocket felt is also a stop the glance explains. WAAPI
   *  rather than a class so re-triggering needs no bookkeeping; honours
   *  reduced motion by simply not moving. */
  const joltTransport = () => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    for (const el of document.querySelectorAll('.npScreen__transport, .playerBarShell')) {
      (el as HTMLElement).animate(
        [
          { transform: 'translateX(0)' },
          { transform: 'translateX(-4px)' },
          { transform: 'translateX(4px)' },
          { transform: 'translateX(-2px)' },
          { transform: 'translateX(0)' },
        ],
        { duration: 380, easing: 'ease-out' },
      );
    }
  };

  /** Forget an episode. Called wherever the listener's intent changes, so a
   *  timer can never fire against a deck they have already moved on from. */
  const clearStall = () => {
    window.clearTimeout(recoverTimer.current);
    recoverTimer.current = undefined;
    stalledAt.current = 0;
    resumeCount.current = 0;
    setBuffering(false);
  };

  /**
   * Put the active deck back where it was, on a new connection.
   *
   * Deliberately goes through the same two lines a normal track load uses -
   * `pendingPlay` then `setActiveSrc` - so the existing `canplay` handler does
   * the starting, with its ramp token, its seat level and its volume, exactly
   * as it always does. No second start path, no new fade, nothing for the
   * careful machinery below to fight with.
   */
  const resumeInPlace = async () => {
    const audio = activeAudio();
    const current = liveRef.current.track;
    if (!audio || !current || remoteOnlyRef.current) return;
    if (resumeCount.current >= MAX_RELOADS_PER_TRACK) {
      // Out of attempts: stop claiming to play - and say so in the hand.
      // (Foreground only: iOS parks the Taptic Engine for backgrounded
      // apps, so a pocketed stop stays silent. The lock screen's frozen
      // play state is that case's messenger.)
      fireNativeHaptic('warning');
      joltTransport();
      pendingPlay.current = false;
      wantPlaying.current = false;
      setPlaying(false);
      setBuffering(false);
      return;
    }
    const at = audio.currentTime || lastGoodPos.current;
    resumeCount.current += 1;
    const url = await loadAudioUrl(current.path);
    if (!url) return;
    // A crossfade may have swapped decks while that resolved; landing this on
    // the wrong element would restart a track nobody asked for.
    if (activeAudio() !== audio || liveRef.current.track?.path !== current.path) return;
    const fresh = url.startsWith('http')
      ? `${url}${url.includes('?') ? '&' : '?'}r=${(resumeNonce.current += 1)}`
      : url;
    // Seek before the element is audible: loadedmetadata always precedes
    // canplay, so the start that canplay performs is already at the right spot.
    audio.addEventListener(
      'loadedmetadata',
      () => {
        try {
          audio.currentTime = at;
        } catch {
          // A source that refuses the seek still plays; it just starts over.
        }
      },
      { once: true },
    );
    pendingPlay.current = true;
    setActiveSrc(fresh);
  };

  /**
   * Turning an effect on or off re-colours the song already playing, in place.
   *
   * The rack changes the stream's URL, but a media element that is already
   * playing does not care that the URL it was handed would now be spelled
   * differently - it holds an open connection to the old one. Without this,
   * a switch would appear to do nothing until the next track, which reads as
   * broken rather than as deferred.
   *
   * `resumeInPlace` is exactly the right instrument: it re-resolves the source
   * and returns to the same position through the ordinary canplay path. Its
   * retry budget is reset first, because that budget counts FAILURES - a
   * deliberate change is not one, and a song that stalled twice this morning
   * should still be allowed to go lofi.
   *
   * Local files skip it: nothing about their URL changed (the server is what
   * applies effects), so reloading would restart the song to no purpose.
   */
  const rack = useEffects();
  const rackWas = useRef(rack);
  useEffect(() => {
    const before = rackWas.current;
    rackWas.current = rack;
    if (before === rack) return;
    if (!liveRef.current.track || !isRemotePath(liveRef.current.track.path)) return;
    resumeCount.current = 0;
    void resumeInPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rack is the trigger; resumeInPlace is redefined every render
  }, [rack]);

  /** Arm the ladder. Idempotent: an episode already running keeps its timer. */
  const noteStall = () => {
    if (!wantPlaying.current || remoteOnlyRef.current) return;
    if (stalledAt.current !== 0) return;
    stalledAt.current = Date.now();
    setBuffering(true);
    const wait = RETRY_BACKOFF_MS[resumeCount.current] ?? 4000;
    window.clearTimeout(recoverTimer.current);
    recoverTimer.current = window.setTimeout(() => {
      recoverTimer.current = undefined;
      // Still dry? Only then is it worth throwing the connection away.
      if (stalledAt.current !== 0) void resumeInPlace();
    }, STALL_GRACE_MS + wait);
  };

  /** Sound is back. */
  const noteFlowing = () => {
    if (stalledAt.current === 0 && !buffering) return;
    window.clearTimeout(recoverTimer.current);
    recoverTimer.current = undefined;
    stalledAt.current = 0;
    setBuffering(false);
  };
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
    // iOS routes through the audio graph like every other platform, so the
    // equalizer, meter visuals, night mode, and the boost range work here too.
    // WKWebView can interrupt an AudioContext when the screen locks, so every
    // path below carries an element-volume fallback and the watchdog nudges an
    // interrupted context back - the occasional lock-screen hiccup is the trade
    // for the EQ being on by default.
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
      // Dev-only: the graph on the window, so a driven browser can assert
      // what a person would otherwise have to hear.
      if (import.meta.env.DEV) {
        (window as unknown as { __afmMeter?: AnalyserMeter }).__afmMeter = analyserRef.current;
      }
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

  /**
   * Coming back to the app while music is playing lands on Now Playing.
   *
   * This is the lock-screen widget, Control Center, the CarPlay card and the
   * headphone tap - every "audio spot" that opens the app. There is no API
   * that says WHICH of them did it, or even that one of them did: iOS hands a
   * launch from the now-playing artwork to the app exactly like any other
   * launch. So the signal is the honest proxy - the app came forward and sound
   * is coming out of it - and the guards below are what keep that from
   * hijacking an ordinary app switch.
   *
   * Two seconds in the background is the floor: a share sheet, a permission
   * prompt or the app switcher flashing past are all shorter than that, and
   * none of them should land you in a full-screen player.
   *
   * `remoteOnly` stands in for activeElsewhere (defined later from it): when
   * another device holds the audio, this player is not what you came back for.
   */
  const npReturnAt = useRef(0);
  useEffect(() => {
    if (!mobileControls) return;
    const onVisible = () => {
      if (document.visibilityState === 'hidden') {
        npReturnAt.current = Date.now();
        return;
      }
      const away = Date.now() - npReturnAt.current;
      npReturnAt.current = 0;
      if (away < 2000) return;
      if (!audible || remoteOnly) return;
      setNpOpen(true);
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [mobileControls, audible, remoteOnly]);
  const beat = useBeat({ meter, active: audible, at: progress });


  // The phone's own volume, polled while there is something to hear. The
  // hardware buttons fire no event the webview can see, so a poll is the whole
  // mechanism, and the call is one message send into the audio session.
  // Parked entirely when nothing is playing.
  //
  // Quantised to the sixteenths iOS actually moves in: the reading is a float,
  // and passing it through raw means a value that wobbles in the last decimals
  // re-renders this component - one of the largest in the app - for a change
  // no eye can see. Rounding first makes a render happen once per real step of
  // the volume rocker and never otherwise, since React drops a set to an
  // identical number.
  const [systemVolume, setSystemVolume] = useState(1);
  useEffect(() => {
    if (!audible) return;
    let alive = true;
    const read = () => {
      void systemOutputVolume().then((v) => {
        if (alive) setSystemVolume(Math.round(v * 16) / 16);
      });
    };
    read();
    const timer = window.setInterval(read, 400);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [audible]);

  // The dock icon: the brand mark, drawn and shipped once at boot. A dev
  // binary has no bundle icon of its own, so without this the Dock shows the
  // generic executable tile.
  useEffect(() => {
    void initDockWave();
  }, []);
  // What the transport was last ASKED, written synchronously at the moment of
  // asking. The `playing` state says the same thing one render later - too
  // late for the element's own pause event to consult. iOS pauses the media
  // elements itself when the app backgrounds or the session is interrupted,
  // and this ref is how those pauses are told apart from ours: an element
  // pausing while the ref still says play was stopped by the system.
  const wantPlaying = useRef(false);
  // When the app last left the foreground. The suspension pause iOS lands on
  // a playing element arrives within moments of this; a pause arriving
  // minutes later is somebody PRESSING pause - on the lock screen, on the
  // wheel - and must never be fought, whatever path it took to the element.
  const hiddenAt = useRef(0);
  // System pauses fought back against since the app last stood in the
  // foreground. Capped, so a pause the phone insists on (a call, Siri,
  // another app taking exclusive audio) wins after a few rounds instead of
  // being fought forever.
  const resumeAttempts = useRef(0);

  // Coming back to the window wakes the audio graph. The play press already
  // resumes a parked context, but audio that was ALREADY playing gets no
  // press when the OS interrupts the output behind an occluded window - so
  // the return itself is the gesture: refocus and becoming visible both
  // nudge the context, and a running one ignores it for free.
  useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') {
        hiddenAt.current = performance.now();
        // Leaving the app is the moment the graph gets parked, and waiting for
        // the slow pulse below to notice is an audible hole in the music. So
        // reclaim the session and offer the context a resume RIGHT HERE, while
        // the page still has a run loop - iOS gives a backgrounding app a
        // moment to finish what it is doing, and this is what it is for.
        if (isIOS && wantPlaying.current) {
          reactivateAudioSession();
          void analyserRef.current?.resume?.();
        }
        return;
      }
      resumeAttempts.current = 0;
      void analyserRef.current?.resume?.();
      // The return also undoes a pause the background imposed: if the
      // transport still wants playing but the deck sits paused, that pause
      // was the system's - reclaim the session and pick the song back up. A
      // refusal here means the session is truly gone (a call still ringing),
      // and the bar goes honest rather than showing a play that is not on.
      const audio = activeAudio();
      if (wantPlaying.current && audio && audio.paused && !audio.ended) {
        reactivateAudioSession();
        void audio.play().catch(() => {
          wantPlaying.current = false;
          setPlaying(false);
        });
      }
    };
    window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      window.removeEventListener('focus', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, []);

  // The other half of surviving the background: iOS lands a pause on the
  // playing element as the app suspends - even entitled for background audio
  // (UIBackgroundModes + the claimed session), the suspension itself pauses
  // the deck, and nothing un-pauses it. The pause event is the recovery hook:
  // arriving while the transport still wants playing, it was the system's
  // pause, and playing again from right here - session re-claimed first - is
  // what carries the music into the background. Guards, in order: only the
  // active deck (crossfade housekeeping parks the idle one), only against
  // wanted playback, never over a natural end or a stop mid-wind-down, and
  // only a few rounds per background spell so real interruptions win.
  useEffect(() => {
    const els = [audioRef.current, audioBRef.current].filter(
      (el): el is HTMLAudioElement => el !== null,
    );
    const onPause = (event: Event) => {
      const el = event.currentTarget as HTMLAudioElement;
      if (el !== activeAudio()) return;
      if (!wantPlaying.current) return;
      if (el.ended || windingDown.current) return;
      // A hand on the platter paused this element itself - the scratch engine
      // is sounding in its place, and the transport still means "playing".
      // Without this the branch below reads the scratch's own pause as a
      // person's and drops the intent, so letting go would leave the song
      // stopped under a bar that just watched you scrub it.
      if (scratchHeld.current) return;
      // Only the suspension window counts as the system's doing: iOS pauses a
      // playing element within moments of the app leaving the foreground. A
      // pause landing later - or while visible - is a person's (the lock
      // screen's press reaches the element before it reaches any JS), and the
      // transport FOLLOWS it: intent drops here, so neither this handler nor
      // the return-to-foreground wake ever un-pauses what somebody paused.
      const suspension =
        document.visibilityState === 'hidden' &&
        performance.now() - hiddenAt.current <= 10_000 &&
        resumeAttempts.current < 3;
      if (!suspension) {
        wantPlaying.current = false;
        setPlaying(false);
        return;
      }
      resumeAttempts.current += 1;
      reactivateAudioSession();
      void analyserRef.current?.resume?.();
      void el.play().catch(() => {
        wantPlaying.current = false;
        setPlaying(false);
      });
    };
    els.forEach((el) => el.addEventListener('pause', onPause));
    return () => els.forEach((el) => el.removeEventListener('pause', onPause));
  }, []);

  // The opted-in iPhone graph's lifeline: WebKit parks an AudioContext as
  // 'interrupted' when the screen locks, and no event announces the moment it
  // may come back - so while music should be playing through a graph on iOS,
  // a slow pulse re-claims the session and offers the context a resume. The
  // kit's resume() ignores a running context, so a healthy graph pays one
  // no-op call every few seconds and a parked one comes back at the first
  // pulse iOS will honour.
  useEffect(() => {
    if (!isIOS) return;
    const interval = window.setInterval(() => {
      if (!wantPlaying.current || !analyserRef.current) return;
      // Five seconds is the steady-state heartbeat, but the window that
      // actually matters is the few seconds after the app changes state - so
      // the pulse runs fast for a spell after each transition and settles back
      // once the graph has clearly survived it.
      reactivateAudioSession();
      void analyserRef.current.resume?.();
    }, 5000);
    const quick = window.setInterval(() => {
      if (!wantPlaying.current || !analyserRef.current) return;
      if (performance.now() - hiddenAt.current > 8000) return;
      void analyserRef.current.resume?.();
    }, 600);
    return () => {
      window.clearInterval(interval);
      window.clearInterval(quick);
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
    publish({ meter, audible, track: track ?? IDLE_TRACK, position: coarsePosition });
  }, [publish, meter, audible, track, coarsePosition]);

  // The listening log. One report per listen-through, once the track has
  // genuinely been HEARD - thirty seconds of actual playback, or half its
  // length for anything shorter, the shape of threshold streaming services
  // count by. Measured as accumulated listened time, not a position reached:
  // a scrub or a jump forward to 0:45 moves the clock without playing those
  // seconds, and must not count as a listen. A new track resets the tally;
  // repeat-one restarts it, so every spin is logged. Server only - local
  // listening has no account to write history against.
  const { session: playSession, renew: renewSession } = useServerSession();
  const playSessionRef = useRef(playSession);
  playSessionRef.current = playSession;
  const renewSessionRef = useRef(renewSession);
  renewSessionRef.current = renewSession;

  // The EVENT log rides beside the play counter below: the counter keeps the
  // legacy shelves (artist top songs) fed, while events - with their length,
  // completion and skip verdicts - feed the stats page and the curator's
  // self-tuning. Same honesty rules, same privacy switch. The reporter samples
  // this snapshot once a second and owns all the bookkeeping.
  const listenSnapRef = useRef<ListenSnapshot>({
    track: null,
    audible: false,
    duration: 0,
    session: null,
    record: false,
  });
  listenSnapRef.current = {
    track,
    audible: audible && !scrubbing.current,
    duration,
    session: playSession,
    record: playbackRef.current.saveHistory,
  };
  useEffect(() => {
    const reporter = createListenReporter(() => listenSnapRef.current);
    return reporter.dispose;
  }, []);

  // The Canvas clip for whatever is open. Cleared on every change first, so a
  // previous song's clip is never left playing over a new one; a null answer -
  // no clip, or a server with no Spotify session set up - simply leaves the
  // blurred cover in place. Only while the sheet is open, since the clip is a
  // full-screen surface nobody sees from the mini strip.
  useEffect(() => {
    setNpCanvas(null);
    if (!npOpen || !track || !playSession) return;
    const controller = new AbortController();
    void fetchCanvas(
      playSession,
      track.title,
      track.artist,
      controller.signal,
      trackIdFromPath(track.path),
    ).then((url) => {
      if (!controller.signal.aborted) setNpCanvas(url);
    });
    return () => controller.abort();
  }, [npOpen, track?.title, track?.artist, playSession]);
  const listened = useRef({ path: '' as string, seconds: 0, prev: 0, reported: false });
  useEffect(() => {
    if (!track) return;
    const l = listened.current;
    if (l.path !== track.path) {
      listened.current = { path: track.path, seconds: 0, prev: coarsePosition, reported: false };
      return;
    }
    const delta = coarsePosition - l.prev;
    l.prev = coarsePosition;
    // Only forward, only a natural tick's worth (<=2s), only while genuinely
    // playing and not scrubbing - anything larger is a seek and buys no
    // credit. A backward jump (rewind) re-arms the report for the next spin.
    // The rearm also restarts the tally: without the reset, seconds already
    // past the threshold would log a duplicate play the instant a rewind
    // lands, rather than after another genuine listen-through.
    if (delta < 0) {
      l.reported = false;
      l.seconds = 0;
    }
    if (playing && !scrubbing.current && delta > 0 && delta <= 2) {
      l.seconds += delta;
    }
    if (l.reported) return;
    const threshold = Math.min(30, Math.max(5, (duration || 60) / 2));
    if (l.seconds < threshold) return;
    l.reported = true;
    // The privacy switch: with history off the listen is simply never written.
    // Marked reported all the same, so flipping the switch mid-song does not
    // retroactively log a listen that began under "off".
    if (!playbackRef.current.saveHistory) return;
    const id = trackIdFromPath(track.path);
    if (id !== null && playSessionRef.current) reportPlay(playSessionRef.current, id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the clock drives it; the rest ride refs or are stable per tick
  }, [coarsePosition, playing, track, duration]);

  // ── The audiobook bookmark ───────────────────────────────────────────────
  //
  // A book is a place you return to, so the server learns where the listener
  // got to: every twenty seconds while a book section plays, and once more the
  // moment it pauses or the track changes. Music never reports - resuming a
  // song mid-verse is nobody's habit, and the chatter would buy nothing. The
  // position rides a ref so the interval never re-arms on every tick.
  useEffect(() => {
    if (!track || track.kind !== 'book') return;
    const id = trackIdFromPath(track.path);
    if (id === null) return;
    const send = () => {
      const s = playSessionRef.current;
      if (s) void reportPosition(s, id, positionRef.current * 1000).catch(() => {});
    };
    let timer: number | undefined;
    if (playing) {
      timer = window.setInterval(send, 20_000);
    }
    return () => {
      if (timer !== undefined) window.clearInterval(timer);
      // The parting word: pause, track change, or the sheet closing all land
      // the latest position before the interval dies.
      send();
    };
  }, [track, playing]);

  // The other half of the bookmark: a book section OPENS where the listener
  // left it. Runs once per track, only after the deck has learned a real
  // duration (seeking before the source is ready gets clobbered by the load),
  // and only for a spot worth returning to - past the first few seconds,
  // short of the end. commitSeek is the same door the scrubber uses, so every
  // clock, crossfade guard and republish rides along.
  const resumedPath = useRef<string | null>(null);
  useEffect(() => {
    if (!track || track.kind !== 'book' || !(duration > 0)) return;
    if (resumedPath.current === track.path) return;
    resumedPath.current = track.path;
    const id = trackIdFromPath(track.path);
    const s = playSessionRef.current;
    if (id === null || !s) return;
    let live = true;
    void fetchPlayStates(s)
      .then((states) => {
        if (!live) return;
        const mine = states.find((st) => st.trackId === id);
        if (!mine) return;
        const to = mine.positionMs / 1000;
        if (to > 15 && to < duration - 15) commitSeek(to);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- commitSeek is rebuilt every render; the guard ref keeps this once-per-track
  }, [track, duration]);

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

  // The system transport, wired through WebKit's own media session - the path
  // the lock screen and Control Center use EVERYWHERE, iOS included: with
  // playback running through the <audio> elements, WebKit claims the OS
  // now-playing session and its claim beats carplay.m's native writes (the
  // phone showed the generic "AttackFM" card with ±10s skips - WebKit's
  // defaults - whenever this stayed unbound). Feeding the claim is the only
  // move that sticks. Double-delivery with the native command targets is not
  // a risk in practice: while WebKit holds the claim its handlers are the
  // ones iOS calls, and the native targets only matter when it does not.
  useEffect(() => {
    bindMediaSessionHandlers({
      play: () => carPlayControls.current?.setPlaying(true),
      pause: () => carPlayControls.current?.setPlaying(false),
      next: () => carPlayControls.current?.next(),
      previous: () => carPlayControls.current?.previous(),
      seek: (seconds) => carPlayControls.current?.seek(seconds),
    });
  }, []);

  // The discontinuities the extrapolated clock cannot cover: a new track, a
  // play or pause, a duration finally learned from metadata. The media session
  // is the claimant everywhere (see the binding above); on iOS the native push
  // ALSO goes out, because carplay.m feeds the car's own templates from it and
  // it is the standing fallback for the moments WebKit holds no claim.
  useEffect(() => {
    if (!track) return;
    carPlaySentPos.current = positionRef.current;
    updateMediaSessionMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: artwork?.startsWith('http') ? artwork : null,
    });
    updateMediaSessionState({ duration, position: positionRef.current, playing });
    // Android's half of the same sentence: a WebView does not publish the
    // page's mediaSession to the system, so without this the lock screen, the
    // notification and an Android Auto dashboard know nothing. No-ops
    // everywhere else.
    setNativeNowPlaying({
      title: track.title,
      artist: track.artist,
      album: track.album,
      durationSecs: duration,
    });
    setNativePlaybackState(playing, positionRef.current);
    if (isIOS) {
      void pushCarPlayNowPlaying({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artUrl: artwork?.startsWith('http') ? artwork : '',
        duration,
        position: positionRef.current,
        playing,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on identity, state, and length; position rides along
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
    updateMediaSessionState({ duration, position: coarsePosition, playing });
    setNativePlaybackState(playing, coarsePosition);
    if (isIOS) {
      void pushCarPlayNowPlaying({
        title: track.title,
        artist: track.artist,
        album: track.album,
        artUrl: artwork?.startsWith('http') ? artwork : '',
        duration,
        position: coarsePosition,
        playing,
      });
    }
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
    // The restored level, not the default: seeding the graph with the opening
    // value would open a session at full voice for somebody who left the fader
    // at a third. The ref already holds what the state was initialised from.
    applyVolume(volumeRef.current, false);
    // The element always runs at its own speed: the deck's bend is the graph's
    // job now, so nothing here touches playbackRate and there is no pitch
    // preservation to switch off.
    const cleanups = decks.map((audio) => {
      const isActive = () => audio === activeAudio();
      const onTime = () => {
        if (!isActive()) return;
        if (!scrubbing.current) setPosition(audio.currentTime);
        // The clock moving IS the proof sound is coming out, and the spot a
        // recovery would return to. Both are recorded here, in the one handler
        // that only fires while the deck is genuinely advancing.
        lastGoodPos.current = audio.currentTime;
        noteFlowing();
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
        wantPlaying.current = true;
        setPlaying(true);
        // An autoplay the runtime refuses (a queue advance outside any gesture,
        // on a strict browser) rejects; the bar goes back to paused rather than
        // showing a play that is not happening.
        void audio.play().catch(() => {
          wantPlaying.current = false;
          setPlaying(false);
        });
      };
      // A source that cannot load fires error and never canplay: without this
      // the bar would stay showing the previous track's play state forever,
      // over silence.
      //
      // Which error it is decides everything. A decode failure or an
      // unsupported source is about the FILE and will fail again identically,
      // so it stops - the case this handler was written for, a cached row whose
      // local file was deleted. A network error on a streamed track is about
      // the WIRE (a dropped connection, a server restart, an aged token) and
      // the same bytes are still there to be asked for again, so it recovers
      // rather than ending the song.
      const onError = () => {
        if (!isActive() || !audio.error) return;
        const code = audio.error.code;
        const networkish =
          code === MediaError.MEDIA_ERR_NETWORK || code === MediaError.MEDIA_ERR_ABORTED;
        const remote = !!liveRef.current.track && isRemotePath(liveRef.current.track.path);
        // A 401 from an aged stream token does not always read as a network
        // error - the element may report the not-a-media-file answer as an
        // unsupported source. On a remote track that shape gets the same
        // recovery, because resumeInPlace re-resolves the URL and the renewal
        // below may be exactly what fixes it; a genuinely broken file still
        // stops for good once the ladder runs out.
        const renewable =
          networkish || (remote && code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED);
        if (renewable && remote && resumeCount.current < MAX_RELOADS_PER_TRACK) {
          // Re-mint the stream token before the retry resolves its URL. Cheap
          // insurance: it is latched to once a minute inside the provider, and
          // an expired token is the one cause a plain reload can never heal.
          void renewSessionRef.current().catch(() => {});
          setBuffering(true);
          window.clearTimeout(recoverTimer.current);
          recoverTimer.current = window.setTimeout(
            () => {
              recoverTimer.current = undefined;
              void resumeInPlace();
            },
            RETRY_BACKOFF_MS[resumeCount.current] ?? 4000,
          );
          return;
        }
        // The same honest stop as the ladder running out, felt the same way.
        if (wantPlaying.current) {
          fireNativeHaptic('warning');
          joltTransport();
        }
        pendingPlay.current = false;
        wantPlaying.current = false;
        setPlaying(false);
        setBuffering(false);
      };
      // The buffer running dry, and refilling. Neither was listened for, which
      // is why a hiccup used to be indistinguishable from music.
      const onWaiting = () => {
        if (!isActive()) return;
        noteStall();
      };
      const onPlaying = () => {
        if (!isActive()) return;
        noteFlowing();
      };
      // Fired when the fetch itself goes quiet. Treated the same as a dry
      // buffer: both mean the bytes have stopped arriving.
      const onStalled = () => {
        if (!isActive() || audio.paused) return;
        noteStall();
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
      audio.addEventListener('waiting', onWaiting);
      audio.addEventListener('playing', onPlaying);
      audio.addEventListener('stalled', onStalled);
      return () => {
        audio.removeEventListener('timeupdate', onTime);
        audio.removeEventListener('loadedmetadata', onMeta);
        audio.removeEventListener('ended', onEnded);
        audio.removeEventListener('canplay', onCanPlay);
        audio.removeEventListener('error', onError);
        audio.removeEventListener('seeked', onSeeked);
        audio.removeEventListener('waiting', onWaiting);
        audio.removeEventListener('playing', onPlaying);
        audio.removeEventListener('stalled', onStalled);
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
    // Only the meter here. Claiming the decks used to happen on this gesture
    // too, and it cost the lock screen: see claimDecks below.
    const prime = () => ensureMeter();
    window.addEventListener('pointerdown', prime, { once: true });
    window.addEventListener('keydown', prime, { once: true });
    return () => {
      window.removeEventListener('pointerdown', prime);
      window.removeEventListener('keydown', prime);
    };
  }, []);

  /**
   * Claims a user gesture's media permission for both decks.
   *
   * WebKit refuses to start an <audio> element outside a gesture until that
   * element has been played inside one at least once - and no play this deck
   * makes is inside one: the source is fetched async and playback starts on
   * `canplay`, several hops past the tap. So the first song of a session opens
   * the bar and sits there paused, its play() rejected and swallowed into the
   * paused state by the handler above. Every song after it works, because by
   * then the listener has hit Play by hand and that WAS a gesture.
   *
   * The call rejects here - there is no source yet - and rejecting is the
   * point: WebKit lifts the restriction when play() is CALLED under
   * activation, not when it succeeds. A deck that already has something loaded
   * is left alone, so this can never start a track behind the user's back.
   *
   * The pause immediately after is not tidiness. play() on a sourceless
   * element leaves it un-paused and WAITING for a source - so the next src the
   * crossfade hands the idle deck would start on its own, ahead of the fade
   * that was meant to bring it in. The pause puts the element back exactly as
   * it was found, and the permission stays claimed.
   */
  const claimDecks = () => {
    const decks = [audioRef.current, audioBRef.current];
    // Nothing may be sounding. A play() on an element - even a sourceless one -
    // makes WebKit hand it the OS now-playing session, and it does not hand it
    // back: claiming the IDLE deck while the other one was mid-song took the
    // lock screen and the Dynamic Island away from the song that was actually
    // playing and gave them to an empty element with no title, no artist and no
    // art. That is the whole reason this is mount-only now.
    if (decks.some((el) => el && !el.paused)) return;
    for (const el of decks) {
      if (!el || el.currentSrc) continue;
      void el.play()?.catch(() => {});
      el.pause();
    }
  };

  // ONCE, on mount. The decks are created by the very tap that opened the first
  // song, so the claim goes in on the frame they appear - a LAYOUT effect, not
  // a passive one, because for a discrete event like a click React commits
  // inside the event's own task and this still runs while the gesture counts.
  //
  // Do not add another call site. At mount nothing is playing and there is no
  // now-playing card to lose; at any later moment there usually is.
  useLayoutEffect(() => {
    claimDecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on mount
  }, []);

  // Opening a track points the active deck at its file; the canplay handler
  // above starts it. The object URL is revoked when the track changes so a long
  // session does not leak them.
  useEffect(() => {
    if (!track) return;
    // A placeholder for a still-downloading song has no file to load - its path
    // names an import job. You tapped a new song, so stop whatever was playing
    // (the sheet's "Downloading…" should be honest silence, not the last track
    // running on under it), drop any fade or stall, and load nothing; the real
    // track swaps in and loads here the moment the import lands.
    if (isPendingPath(track.path)) {
      abortCrossfadeRef.current();
      clearStall();
      activeAudio()?.pause();
      wantPlaying.current = false;
      setPlaying(false);
      return;
    }
    // Mirroring another device: show its song, fetch nothing. The strip exists
    // here to display progress and send commands, and buffering a file this
    // device will not play is pure cost.
    if (remoteOnlyRef.current) return;
    // A track a crossfade already carried onto the other deck arrives here
    // pre-played: the handover flipped the decks and handed the track up, so
    // there is nothing to load - loading would start it over from the top.
    if (adoptedPath.current === track.path) {
      adoptedPath.current = null;
      return;
    }
    // Any fade still in flight is about tracks that are no longer next, and
    // a warm deck prefetched for the old track holds a file that is not.
    prefetched.current = null;
    abortCrossfadeRef.current();
    // A new track gets a fresh set of recovery attempts, and any episode armed
    // against the previous one is void.
    clearStall();
    lastGoodPos.current = 0;
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
      // A new source is a new timeline: the old song's tape and ring must
      // not be scrubbable into the new one. And if a hand is still ON the old
      // song - a skip pressed mid-scratch - the session ends here, or the
      // engine's hold outlives its track and mutes everything after it. The
      // release is deliberately before the eject; both are idempotent.
      if (scratchLive.current || scrubbing.current || scratchHeld.current) {
        analyserRef.current?.scrub.release();
        scratchLive.current = false;
        scratchHeld.current = false;
        scratchRolling.current = false;
        scrubbing.current = false;
      }
      scrubTapeFor.current = null;
      analyserRef.current?.scrub.eject();
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

  // Tapping a song you do not own opens Now Playing straight onto it, downloading
  // - the whole point of the placeholder is to answer the tap with the sheet
  // (its art, its name) instead of a silent nothing. Phone only, where the sheet
  // exists; the desktop strip shows the same downloading state in place.
  useEffect(() => {
    if (downloading && mobileControls) setNpOpen(true);
  }, [downloading, mobileControls]);

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
    // Nothing loaded (a fresh device, or one just handed the active seat on a
    // Connect switch): there is no source to start. Refuse rather than start the
    // empty element - the path by which the demo stand-in used to leak out.
    if (next && !track) return;
    const audio = activeAudio();
    wantPlaying.current = next;
    setPlaying(next);
    // Pressing play or pause is a decision that outranks any recovery still
    // pending: a reload landing after a deliberate pause would start the music
    // up again on its own.
    clearStall();
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
        void audio.play().catch(() => {
          wantPlaying.current = false;
          setPlaying(false);
        });
        return;
      }
      // The platter spins up. Cold, from a park: the line is already empty,
      // the deck is set at the floor while nothing can be heard, and the
      // level comes straight back (90ms) while the pitch takes its time -
      // what is heard is the platter catching up, not the music fading in.
      if (!analyserRef.current) {
        applyVolume();
        void audio.play().catch(() => {
          wantPlaying.current = false;
          setPlaying(false);
        });
        rampDeck(1, SPIN_UP_MS);
      } else if (audio.paused) {
        analyserRef.current.setVolume(0);
        analyserRef.current.resetSpeed(RATE_FLOOR);
        void audio.play().catch(() => {
          wantPlaying.current = false;
          setPlaying(false);
        });
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
    wantPlaying.current = true;
    setPlaying(true);
    void audio.play().catch(() => {
          wantPlaying.current = false;
          setPlaying(false);
        });
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
      // from a natural end, and a skip's deck is still mid-song. Intent drops
      // first: the pause event this fires must read as ours, not the system's.
      wantPlaying.current = false;
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
      if (!analyserRef.current) {
        // No seats to counterslide (iOS plays the elements direct): the
        // incoming deck ducks out flat and the outgoing element takes its
        // level straight back.
        if (idle) idle.volume = 0;
        const active = activeAudio();
        if (active) active.volume = Math.min(1, currentAmplitude());
      }
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

  /**
   * The blend without a graph: the elements' own volumes counterslide on a
   * timer, the same equal-power legs the seats would run (sine up, cosine
   * down, so the mix holds level through the middle). A timer rather than an
   * animation frame for the same reason rampDeck uses one - this fade's whole
   * point is finishing while the app is backgrounded.
   */
  const fadeElementBlend = (
    active: HTMLAudioElement,
    idle: HTMLAudioElement,
    span: number,
    token: number,
  ) => {
    const target = Math.min(1, currentAmplitude());
    const start = performance.now();
    const step = () => {
      if (token !== xfadeToken.current) return;
      const t = Math.min(1, (performance.now() - start) / (span * 1000));
      idle.volume = target * Math.sin((t * Math.PI) / 2);
      active.volume = target * Math.cos((t * Math.PI) / 2);
      if (t < 1) setTimeout(step, 1000 / 60);
    };
    step();
  };

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
        if (!analyserRef.current) idle.volume = 0;
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
            if (analyserRef.current) {
              seatOf(idle)?.fadeLevel(1, span);
              seatOf(active)?.fadeLevel(0, span);
            } else {
              fadeElementBlend(active, idle, span, token);
            }
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

  /**
   * With the crossfade off - the default - the second deck used to sit idle
   * and every track ended into a cold load: resolve, connect, buffer, then
   * play, a multi-second hole on cellular against lossless files. This is the
   * load-only half of a crossfade: inside the last seconds the coming track's
   * file is pointed at the idle deck (preload="auto") so the bytes arrive
   * while the current song is still playing, and the ended path adopts the
   * warm deck instead of advancing cold. No blend, no early start - the deck
   * just holds a buffered file until the moment it is wanted.
   *
   * Like a crossfade flight, the pick is recorded ONCE: shuffle re-picks at
   * random per call, so asking again at the end would buffer one track and
   * play another. Remote tracks only - a local file loads in a frame, and
   * prefetching it would leak the object URL the load effect knows to revoke.
   */
  const prefetched = useRef<{ forPath: string; next: Track; url: string } | null>(null);
  const prefetchBusy = useRef(false);
  /** How many seconds before the end the idle deck starts warming. */
  const PREFETCH_LEAD_S = 12;

  const prefetchTick = (el: HTMLAudioElement) => {
    const current = track;
    if (!current || prefetchBusy.current) return;
    if (prefetched.current?.forPath === current.path) return;
    if (remoteOnlyRef.current) return;
    if (!playing || windingDown.current || scrubbing.current) return;
    // These ends do not advance, so there is nothing to warm.
    if (repeat === 'one') return;
    if (playbackRef.current.sleep === 'end-of-track') return;
    const duration = el.duration;
    if (!Number.isFinite(duration) || duration < PREFETCH_LEAD_S + 4) return;
    const remaining = duration - el.currentTime;
    if (remaining > PREFETCH_LEAD_S || remaining <= 0.5) return;
    const next = pickNext(1, repeat === 'all');
    if (next === null || next === 'rewind' || next.path === current.path) return;
    if (!isRemotePath(next.path)) return;
    prefetchBusy.current = true;
    void (async () => {
      try {
        const url = await loadAudioUrl(next.path);
        if (!url) return;
        // The world may have moved while the URL resolved: a new track, a
        // blend claiming the idle deck, or a load already in flight all mean
        // this deck is not ours to point anywhere.
        if (liveRef.current.track?.path !== current.path) return;
        if (xfadeRef.current || pendingPlay.current) return;
        prefetched.current = { forPath: current.path, next, url };
        setIdleSrc(url);
      } finally {
        prefetchBusy.current = false;
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
    if (settings.crossfade <= 0) {
      prefetchTick(el);
      return;
    }
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
        // Without a graph the level lives on the elements themselves; one
        // shared path re-asserts the fader on whichever deck now answers.
        applyVolume();
        setPosition(nowActive.currentTime);
        setDuration(nowActive.duration || 0);
        wantPlaying.current = true;
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
      wantPlaying.current = false;
      setPlaying(false);
      return;
    }
    // Repeat-all with nothing to advance through (the demo stream, a lone
    // track) loops the track itself, matching what repeat-one does beside it.
    if (repeat === 'one' || (repeat === 'all' && (!track || queue.length === 0))) {
      rewindAndPlay();
      return;
    }
    // A warm deck from the prefetch above: adopt it the way a crossfade
    // handover does - flip the decks, start the buffered file, hand the track
    // up with the adopted note - instead of advancing into a cold load. Any
    // doubt (deck holds something else, errored, not buffered enough to start
    // this instant) falls through to the plain advance, which still works.
    const warm = prefetched.current;
    if (warm && warm.forPath === track?.path) {
      prefetched.current = null;
      const idle = idleAudio();
      if (idle && idle.src === warm.url && !idle.error && idle.readyState >= 3) {
        activeIsB.current = !activeIsB.current;
        const nowActive = activeAudio()!;
        // A hard track boundary, same as a plain load: the old song's tape
        // must not be scrubbable into the new one, and a hand still on the
        // old song lets go here. Idempotent, mirrors the load effect.
        if (scratchLive.current || scrubbing.current || scratchHeld.current) {
          analyserRef.current?.scrub.release();
          scratchLive.current = false;
          scratchHeld.current = false;
          scratchRolling.current = false;
          scrubbing.current = false;
        }
        scrubTapeFor.current = null;
        analyserRef.current?.scrub.eject();
        clearStall();
        lastGoodPos.current = 0;
        try {
          nowActive.currentTime = 0;
        } catch {
          // A source that refuses the seek starts from wherever it stands.
        }
        seatOf(nowActive)?.setLevel(1);
        applyVolume();
        setPosition(0);
        setDuration(nowActive.duration || 0);
        wantPlaying.current = true;
        setPlaying(true);
        void nowActive.play().catch(() => {
          // A deck that will not start is an honest stop, same as canplay's.
          wantPlaying.current = false;
          setPlaying(false);
        });
        adoptedPath.current = warm.next.path;
        recentRef.current = [...recentRef.current.slice(-19), warm.next.path];
        onTrackChange?.(warm.next);
        return;
      }
    }
    advance(1, repeat === 'all');
  };
  const endedRef = useRef(handleEnded);
  endedRef.current = handleEnded;

  // Manual skips always wrap: a button that dead-ends at the last row reads
  // as broken. Autoplay honours repeat instead (see handleEnded). With no
  // list to walk (the demo stream, a lone search hit) the handlers are not
  // offered and the kit leaves the buttons out.
  // A single-file audiobook (Audible) carries chapter markers; a book made of
  // many files (LibriVox) has none and behaves like an album. When they are
  // present the skip buttons walk CHAPTERS instead of the queue - a book is one
  // track, so there is nothing else in the queue to advance to.
  const chapters = track?.kind === 'book' ? (track.chapters ?? []) : [];
  const hasChapters = chapters.length > 0;
  // Which chapter the live position sits in, as a label - recomputed each
  // render off `position`, so it ticks over as the book plays.
  const chapterLabel = (() => {
    if (!hasChapters) return null;
    const t = position * 1000;
    let idx = 0;
    for (let i = 0; i < chapters.length; i++) {
      if (t >= chapters[i]!.startMs - 1000) idx = i;
      else break;
    }
    const title = chapters[idx]!.title?.trim();
    const ord = `Chapter ${idx + 1} of ${chapters.length}`;
    // The title only adds something when it is not just "Chapter N" again.
    return title && title.toLowerCase() !== `chapter ${idx + 1}` ? `${ord} · ${title}` : ord;
  })();
  const chapterNow = () => (activeAudio()?.currentTime ?? positionRef.current) * 1000;
  const currentChapter = () => {
    const t = chapterNow();
    let idx = 0;
    for (let i = 0; i < chapters.length; i++) {
      if (t >= chapters[i]!.startMs - 1000) idx = i;
      else break;
    }
    return idx;
  };
  const seekChapter = (dir: 1 | -1) => {
    engaged.current = true;
    abortCrossfade();
    const i = currentChapter();
    if (dir === -1) {
      // Back near a chapter's top means the previous chapter; deeper in means
      // the top of this one - the same convention track-skip-back uses.
      const target = chapterNow() - chapters[i]!.startMs > 3000 ? i : Math.max(0, i - 1);
      commitSeek(chapters[target]!.startMs / 1000);
    } else {
      commitSeek(chapters[Math.min(chapters.length - 1, i + 1)]!.startMs / 1000);
    }
  };

  const canSkip = ((queue.length > 1 && !!onTrackChange) || hasChapters) && !!track;
  const skipForward = () => {
    if (hasChapters) {
      seekChapter(1);
      return;
    }
    engaged.current = true;
    // A skip is a decision about now; a blend toward some other track is not.
    abortCrossfade();
    advance(1, true);
  };
  const skipBack = () => {
    if (hasChapters) {
      seekChapter(-1);
      return;
    }
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
    scrubValue.current = to;
    setPosition(to);
  };
  // The live scrub target, committed on release by the full-screen scrubber
  // (the raw Slider has no seek-end callback of its own).
  const scrubValue = useRef(0);

  // Repeat cycles the way the strip's own control does: off → all → one → off.
  const cycleRepeat = () =>
    setRepeat((r) => (r === 'off' ? 'all' : r === 'all' ? 'one' : 'off'));

  // A tap on the strip's dead space (the artwork, the title, the empty rail -
  // not a control) lifts the full-screen Now Playing. Guarded to touch, where
  // the strip is small and the big surface earns its keep; the desktop strip
  // stays a strip.
  const openNowPlaying = (event: React.MouseEvent) => {
    if (!track || npDocked) return;
    // A swipe ends in a click too; the gesture already had its meaning.
    if (draggedRef.current) return;
    const el = event.target as HTMLElement;
    if (el.closest('button, a, input, [role="slider"], [role="menu"], [role="menuitem"]')) return;
    // The sheet has weight; lifting it should too. (The strip's dead space is
    // not a button, so the delegated press tick never covers this tap.)
    fireNativeHaptic('light');
    setNpOpen(true);
  };

  // ── Scratching ───────────────────────────────────────────────────────────
  //
  // A hand on the disc IS the transport, the way a TP-7's reel or a record
  // under a needle is: touching it freezes the music where it stands, turning
  // it sounds the song at exactly the speed of the turn - forwards, backwards,
  // silent when the hand rests - and letting go plays on from wherever the
  // hand left it.
  //
  // The sound comes from the kit's scratch engine (`meter.scrub`), a tape
  // loop in the audio graph that has been recording everything played. On
  // grab the element is paused - raw, no brake ceremony; the finger stop IS
  // the brake - and the engine's read head chases the hand across that tape.
  // This is what the element itself can never do: it cannot play backwards,
  // and seeking it repeatedly is a decoder restart per write, which is why
  // the old throttled-currentTime scratch stuttered at normal pitch instead
  // of sounding like a hand on a record.
  //
  // The tape only holds what has PLAYED, which is exactly vinyl's own rule:
  // you scratch the groove under the needle. Winding forward past the grab
  // point has no tape to sound, so it walks the bar silently and the release
  // seeks there - a jog, same as the scrubber.
  //
  // Falls back to the old seek-preview scratch wherever the engine cannot
  // stand: no worklet, the music sounding on another device (a remote's disc
  // moves that device's song by seeks over the wire), or a brake mid-fall.
  const scratchPos = useRef(0);
  const lastScratchWrite = useRef(0);
  /** An audible, engine-backed scratch is in progress. */
  const scratchLive = useRef(false);
  /** We paused the element ourselves for the hold; the element's pause
   *  listener must read the stop as ours, not as a person's. */
  const scratchHeld = useRef(false);
  /** The song was rolling when the hand landed, so release resumes it. */
  const scratchRolling = useRef(false);
  /** Song time at the grab; the engine's offsets are relative to this. */
  const scratchAnchor = useRef(0);
  /** Where the hand has asked to be, seconds relative to the anchor. */
  const scratchTarget = useRef(0);
  /** Which track's whole-song tape is loaded or loading - one fetch per
   *  track, however many grabs. */
  const scrubTapeFor = useRef<string | null>(null);

  /**
   * Fetch-and-fold the whole song for the engine, once per track, off the
   * first moment scratching becomes plausible (the screen with the disc
   * opening, or a hand landing on it). Until it lands the ring carries the
   * scratch; after it, the head roams the entire file.
   */
  const armScrubTape = () => {
    const t = track;
    const scrub = analyserRef.current?.scrub;
    if (!t || !scrub?.ready() || scrubTapeFor.current === t.path) return;
    scrubTapeFor.current = t.path;
    void loadScrubTape(t, playSessionRef.current).then((tape) => {
      if (!tape || scrubTapeFor.current !== t.path) return;
      analyserRef.current?.scrub.load(tape.pcm, tape.rate, tape.duration);
    });
  };

  // The disc coming on screen is the moment scratching becomes plausible, and
  // the tape takes a few seconds to fetch and fold - so it is armed here, not
  // only on the first grab, and is usually loaded before a hand arrives.
  useEffect(() => {
    if (npOpen) armScrubTape();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- armed per open/track; the armer latches per track itself
  }, [npOpen, track]);

  /** The hand lands on the platter. Decides ONCE whether this scratch is the
   *  audible kind, and if so freezes the music under the finger. */
  const onScratchBegin = () => {
    const audio = activeAudio();
    if (!audio || scrubbing.current) return;
    scrubbing.current = true;
    scratchPos.current = audio.currentTime || 0;
    const scrub = analyserRef.current?.scrub;
    const live = !!scrub && scrub.ready() && !activeElsewhere && !windingDown.current;
    scratchLive.current = live;
    if (!live || !scrub) return;
    scratchAnchor.current = scratchPos.current;
    scratchTarget.current = 0;
    scratchRolling.current = !audio.paused;
    scrub.hold(scratchAnchor.current);
    armScrubTape();
    if (!audio.paused) {
      // Freeze, not pause: intent stays "playing" (the guard in the pause
      // listener is what keeps it), any deck ramp in flight is orphaned, and
      // the element stops buying audio nobody will hear. The engine's 5ms
      // voice fade is the de-click; there is no brake because a hand landing
      // on a record stops it dead.
      scratchHeld.current = true;
      rampToken.current += 1;
      audio.pause();
    }
  };

  const onScratch = (deltaSeconds: number) => {
    const audio = activeAudio();
    if (!audio) return;
    // A move with no begin (the disc grabbed before the engine existed, or a
    // stale capture): fall into the legacy path below from where the song is.
    if (!scrubbing.current) {
      scratchPos.current = audio.currentTime || 0;
      scrubbing.current = true;
      scratchLive.current = false;
    }
    const limit = duration || audio.duration || 0;
    if (scratchLive.current) {
      const scrub = analyserRef.current?.scrub;
      // The hand's position, capped to the song. The engine parks at its own
      // tape's edges besides.
      scratchTarget.current = Math.max(
        -scratchAnchor.current,
        Math.min(
          limit > 0 ? limit - scratchAnchor.current : Number.POSITIVE_INFINITY,
          scratchTarget.current + deltaSeconds,
        ),
      );
      scrub?.move(scratchTarget.current);
      // The bar follows what is heard: the head's actual whereabouts, which
      // lag the hand by the spring's ~30ms. Only where the head cannot go -
      // forward of the grab with no whole-song tape yet - does the hand's own
      // position carry the story, as a silent jog.
      const shown =
        scratchTarget.current > 0 && !scrub?.loaded()
          ? scratchTarget.current
          : (scrub?.offset() ?? scratchTarget.current);
      scratchPos.current = Math.max(
        0,
        limit > 0 ? Math.min(limit, scratchAnchor.current + shown) : scratchAnchor.current + shown,
      );
      setPosition(scratchPos.current);
      return;
    }
    // Legacy scratch: the seek-preview. Twelve decoder restarts a second is
    // the most that reads as movement without stuttering; it cannot sound a
    // direction, only a place.
    scratchPos.current = Math.max(
      0,
      limit > 0 ? Math.min(limit, scratchPos.current + deltaSeconds) : scratchPos.current + deltaSeconds,
    );
    setPosition(scratchPos.current);
    const now = performance.now();
    if (now - lastScratchWrite.current < 80) return;
    lastScratchWrite.current = now;
    try {
      audio.currentTime = scratchPos.current;
    } catch {
      // A source mid-load refuses the write; the next move tries again.
    }
  };

  /** The hand came off: land the position properly, with all the bookkeeping a
   *  seek owes (the hub, the crossfade, the stall watch), and - for the
   *  audible scratch - put the music back the way the hand found it. */
  const onScratchEnd = () => {
    if (!scrubbing.current) return;
    if (!scratchLive.current) {
      commitSeek(scratchPos.current);
      return;
    }
    scratchLive.current = false;
    const scrub = analyserRef.current?.scrub;
    // What was heard is where we land: the settled head. Only a silent
    // forward jog (no whole-song tape yet) uses the hand's own position.
    const settled = scrub ? scrub.release() : 0;
    const offset =
      scratchTarget.current > 0 && !scrub?.loaded() ? scratchTarget.current : settled;
    const audio = activeAudio();
    const limit = duration || audio?.duration || 0;
    const to = Math.max(
      0,
      limit > 0 ? Math.min(limit, scratchAnchor.current + offset) : scratchAnchor.current + offset,
    );
    const moved = Math.abs(to - scratchAnchor.current) > 0.15;
    if (scratchRolling.current) {
      // The motor catches the platter FIRST, then the jump lands as a seek on
      // a playing element - the same order and machinery as the scrub bar,
      // whose seeks are the battle-tested ones. The other order (seek the
      // paused element, then play) lost forward seeks on real streams: a
      // paused element asked to jump into unbuffered territory could resume
      // from the anchor as if nothing happened.
      scratchHeld.current = false;
      scratchRolling.current = false;
      if (!moved) {
        scrubbing.current = false;
        setPosition(scratchAnchor.current);
        setPlayingState(true);
        return;
      }
      ensureMeter();
      rampToken.current += 1;
      windingDown.current = false;
      // Silent through the catch: commitSeek's mute-through-seek owns the
      // unmute (its seeked handler fades in), and the spin-up runs under it
      // so the fade lands mid-climb - the platter catching, then the needle.
      analyserRef.current?.setVolume(0);
      void audio?.play().catch(() => {
        wantPlaying.current = false;
        setPlaying(false);
      });
      commitSeek(to);
      analyserRef.current?.resetSpeed(RATE_FLOOR);
      rampDeck(1, SPIN_UP_MS);
      return;
    }
    scratchHeld.current = false;
    if (moved) {
      commitSeek(to);
    } else {
      // A grab-and-release that went nowhere owes no seek - a seek is a
      // refetch on a stream - just its scrubbing flag back.
      scrubbing.current = false;
      setPosition(scratchAnchor.current);
    }
  };

  const commitSeek = (to: number) => {
    scrubbing.current = false;
    setPosition(to);
    // The listener has chosen a spot; a recovery aimed at the old one is void,
    // and the seek itself earns a fresh set of attempts.
    clearStall();
    lastGoodPos.current = to;
    // A seek is a discontinuity the extrapolated clock cannot follow, so it is
    // one of the moments this device (when active) republishes to the hub.
    seekEpoch.current += 1;
    setSeekTick((t) => t + 1);
    // A seek re-earns the whole track - dragging back out of the fade window
    // must not leave a half-blended next track playing underneath it.
    abortCrossfade();
    // The deck's backlog is dropped WITH the jump, and before it: the line
    // holds the last beat of pre-seek signal, and left alone it would play
    // that first and then run behind the bar by its length - music trailing
    // the position it claims. A flush is a discontinuity, but so is the seek
    // itself, and one cut is what the ear was just promised.
    analyserRef.current?.resetSpeed(1);
    // The scratch tape forgets across the jump for the same reason the deck
    // does: its ring maps offsets onto the element's timeline, and a seek
    // breaks that map - a scratch after one would sound the song from before
    // the jump as if it belonged here.
    analyserRef.current?.scrub.clear();
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

  // ── Android background playback ──────────────────────────────────────────
  //
  // Two things Android needs that no other platform does, both living in
  // MainActivity and reached through androidAudio.ts (a no-op everywhere else).
  //
  // Telling it whether sound is coming out is what starts and stops the
  // foreground service - the contract that stops the process being treated as
  // spare memory the moment navigation wants some. `audible` rather than
  // `playing`, so a deck that is paused, muted or handed to another device does
  // not leave an ongoing notification standing over silence.
  useEffect(() => {
    setNativePlaying(audible);
    // The cache sweep widens to six download lanes on an idle deck and
    // narrows back to two under a song - this is the signal it sizes by.
    notePlaybackAudible(audible);
  }, [audible]);

  // And obeying focus when the system needs the speaker. These are the player's
  // own play and pause, so an interruption steers the deck exactly as a button
  // would and everything downstream follows. A duck never arrives here - Android
  // lowers and restores the volume itself, and pausing for one is what makes a
  // spoken direction stop the music for the rest of the drive.
  useEffect(
    () =>
      bindAudioFocus({
        pause: () => carPlayControls.current?.setPlaying(false),
        resume: () => carPlayControls.current?.setPlaying(true),
      }),
    [],
  );

  // The MediaSession's buttons - a steering wheel, an Android Auto dashboard,
  // the lock screen, the notification's own row. They arrive in the service and
  // are handed here by MainActivity; these are the player's own controls, so a
  // press out there is the same press as one in here.
  useEffect(
    () =>
      bindNativeTransport({
        play: () => carPlayControls.current?.setPlaying(true),
        pause: () => carPlayControls.current?.setPlaying(false),
        next: () => carPlayControls.current?.next(),
        previous: () => carPlayControls.current?.previous(),
        seek: (seconds) => carPlayControls.current?.seek(seconds),
      }),
    [],
  );

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

  // Switching the boost range off pulls a fader parked above unity back to it,
  // through the same path a hand on the fader takes - so the audible gain
  // drops with the setting, not at the next incidental pause.
  useEffect(() => {
    if (!volumeBoost && volumeRef.current > VOLUME_UNITY) setVolumeState(VOLUME_UNITY);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setVolumeState is stable-per-render plumbing; the setting is the trigger
  }, [volumeBoost]);

  // ── AttackFM Connect ──────────────────────────────────────────────────────
  //
  // This device is either the ACTIVE one (it plays and publishes state) or a
  // REMOTE (it mirrors what plays elsewhere and its controls send commands).
  // The seam is small on purpose: the controller below routes hub commands into
  // the same local handlers a tap would, and one effect republishes state on
  // each discontinuity. Off a server the provider is inert and all of this is
  // a no-op, so a lone device just plays.
  // (connect is read near the top of the component - see remoteOnly.)
  // The controller is registered once but must act through the current render's
  // handlers and values, so it reaches them all through this ref.
  const liveRef = useRef({
    playing, position, duration, track, shuffle, repeat, volume, queue,
    setPlayingState, skipForward, skipBack, commitSeek, setVolumeState,
    libraryTracks, onTrackChange, onQueueChange,
  });
  liveRef.current = {
    playing, position, duration, track, shuffle, repeat, volume, queue,
    setPlayingState, skipForward, skipBack, commitSeek, setVolumeState,
    libraryTracks, onTrackChange, onQueueChange,
  };
  // A cross-track "play here": the track is loaded via onTrackChange, then this
  // remembered seek+play is applied once it has actually loaded (below).
  const resumeRef = useRef<{ trackId: number; positionMs: number; play: boolean } | null>(null);

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
    return s.playing ? base + Math.max(0, (Date.now() - s.updatedAt) / 1000) : base;
  })();

  // Becoming a remote pauses local audio, even if the explicit release did not
  // arrive (a seat claimed out from under this device).
  useEffect(() => {
    if (activeElsewhere && playing) setPlayingState(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to the mode flip
  }, [activeElsewhere]);

  // What the strip shows and what its controls do, swapped by mode. Active (or
  // alone): local track, local handlers. Remote: the other device's track, and
  // controls that send commands to it.
  const dispTrack = activeElsewhere ? (remoteTrack ?? track) : track;
  const dispPlaying = activeElsewhere ? !!connect.session?.playing : playing;
  const dispPosition = activeElsewhere ? remotePosition : position;
  const dispDuration = activeElsewhere ? (remoteTrack?.duration ?? 0) : duration;
  const dispArtwork = activeElsewhere ? (remoteTrack?.artwork ?? TRACK_ART) : artwork;
  // Paused, the strip can be pushed off the bottom of the screen; it comes
  // back by itself with the next sound. Reads dispPlaying rather than the
  // local deck so a remote's playback holds the bar here too.
  const { dismissed, shellRef, draggedRef } = usePlayerDismiss(dispPlaying);

  const onPlayingChangeDisp = activeElsewhere
    ? (p: boolean) => connect.sendCommand({ action: p ? 'play' : 'pause' })
    : setPlayingState;
  const onSkipBackDisp = activeElsewhere
    ? () => connect.sendCommand({ action: 'prev' })
    : canSkip
      ? skipBack
      : undefined;
  const onSkipForwardDisp = activeElsewhere
    ? () => connect.sendCommand({ action: 'next' })
    : canSkip
      ? skipForward
      : undefined;
  const onSeekEndDisp = activeElsewhere
    ? (s: number) => connect.sendCommand({ action: 'seek', positionMs: Math.round(s * 1000) })
    : commitSeek;
  const onScrubDisp = activeElsewhere ? () => {} : onScrub;

  // The strip's artwork square, defined once because both strips wear it: the
  // kit's bar on the desktop and the phone's own row. A right-click (or a long
  // press) offers the turning CD or the flat cover; a track without art gets
  // the station mark, so the square is never empty.
  const playerArtwork = (
        <ContextMenu
          aria-label="Artwork style"
          className="artViewTarget"
          content={npArtMenu}
        >
          {artView === 'cd' ? (
            <SpinningDisc
              art={dispArtwork}
              spinning={activeElsewhere ? dispPlaying : audible}
              // A dry buffer spins the platter up rather than stalling it.
              spooling={buffering || downloading}
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
  );

  return (
    <>
      {/* crossOrigin keeps the analyser readable: both the asset protocol and
          the remote demo are cross-origin but CORS-clean (the asset response
          carries ACAO for the window origin), so the graph reads real levels.
          A blob would be the one source to leave bare - but blobs are silent
          through WebKit's analyser, so the asset protocol is used instead. */}
      <audio ref={audioRef} src={src || undefined} crossOrigin="anonymous" preload="metadata" />
      {/* The second deck, silent until a crossfade borrows it - then the two
          alternate, whichever is idle catching the next track. Same CORS rule
          as its twin; preload=auto because when it has a src at all, that file
          is about to be needed inside a fade window. */}
      <audio ref={audioBRef} src={srcB} crossOrigin="anonymous" preload="auto" />
      {/* On touch the strip's dead space is a handle: a tap lifts the
          full-screen Now Playing. display:contents keeps the wrapper out of
          the layout the kit and the shell CSS assume - it only catches the
          bubbling tap. */}
      <div
        ref={shellRef}
        className="playerBarShell"
        data-dismissed={dismissed || undefined}
        onClick={mobileControls ? openNowPlaying : undefined}
      >
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
        artwork={playerArtwork}
        // disp* swap between local playback and mirroring the active device -
        // see the AttackFM Connect block above. Alone or active, these are the
        // local track and handlers; as a remote, the other device's now-playing
        // and controls that command it.
        title={dispTrack?.title ?? 'Funky Chunk'}
        subtitle={
          activeElsewhere
            ? `${dispTrack?.artist ?? ''}${activeDeviceName ? ` · on ${activeDeviceName}` : ''}`
            : (track?.artist ?? 'Kevin MacLeod')
        }
        duration={dispDuration}
        value={dispPosition}
        onValueChange={onScrubDisp}
        onSeekEnd={onSeekEndDisp}
        playing={dispPlaying}
        onPlayingChange={onPlayingChangeDisp}
        // Skip moves between tracks in the list, not within the current one.
        onSkipBack={onSkipBackDisp}
        onSkipForward={onSkipForwardDisp}
        shuffle={shuffle}
        onShuffleChange={setShuffle}
        repeat={repeat}
        onRepeatChange={setRepeat}
        favorite={favorite}
        onFavoriteChange={toggleFavoriteFelt}
        // The mic sits just right of the heart, in the strip's leading rail:
        // the heart is how you feel about the song, the mic is the song's own
        // words. Synced lines light with playback and a press seeks to that
        // line - the seek goes through commitSeek, the same path the bar's
        // own scrubber lands on.
        // On touch the mic folds into the overflow chooser with the rest of
        // the options; the heart the kit renders keeps the leading rail.
        leading={
          mobileControls ? undefined : (
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
                key={(track ?? IDLE_TRACK).path}
                track={track ?? IDLE_TRACK}
                position={position}
                onSeek={commitSeek}
              />
            </div>
          </Popover>
          )
        }
        levels={levels}
        beat={beat}
        // The equalizer and the custom volume fader share the trailing rail; the
        // kit's own volume is dropped (no volume props) since it stops at 100%.
        // On touch the pair folds behind one overflow button - the phone's
        // hardware buttons carry the volume moment to moment, so neither
        // deserves a permanent seat the transport could be spending.
        trailing={
          // iPhone folds into the same mobile overflow as everywhere else now
          // that the graph (and so the equalizer) always runs there.
          mobileControls ? (
            <>
              {/* No device picker on the strip: the "playing on" button lives on
                  the full-screen Now Playing sheet, which has the room for it. */}
              <PluginSlot id="player-trailing" />
              <Popover
                placement="top-end"
                aria-label="Player options"
                className="morePopoverPanel"
                open={moreOpen}
                onOpenChange={(open) => {
                  setMoreOpen(open);
                  if (open) setMoreView('menu');
                }}
                trigger={
                  /* Where the ⋮ used to be. The strip's one trailing control is
                      now the thing you actually reach for mid-song on a phone -
                      where is this playing - rather than a menu of panels. The
                      equalizer moved to the Now Playing sheet with the other
                      playback controls; lyrics already open full-screen from
                      there; and volume belongs to the phone's own buttons (see
                      the mobile volume note). */
                  <IconButton variant="ghost" size="sm" aria-label="Playing on">
                    <MonitorSpeaker size={18} />
                  </IconButton>
                }
              >
                <div className="morePopover">
                  {moreView === 'menu' && <DeviceList />}
                  {/* The strip's popover is the device list and nothing else
                      now. Equalizer, lyrics and volume each left for a better
                      home: the first two to the Now Playing sheet, and volume
                      to the phone's own buttons. */}
                </div>
              </Popover>
            </>
          ) : (
            <>
              {/* Plugin controls lead the app's own cluster, mirroring how the
                  title bar seats plugins ahead of settings. Empty when none
                  contribute. */}
              <PluginSlot id="player-trailing" />
              {/* The equalizer, playlist filing, and device hand-off fold
                  behind one overflow: five trailing buttons were crowding the
                  bar, and none of the three is a moment-to-moment reach.
                  Volume is, so the fader keeps its own seat. */}
              <Popover
                placement="top-end"
                aria-label="Player options"
                className="eqPopoverPanel"
                open={moreOpen}
                onOpenChange={(open) => {
                  setMoreOpen(open);
                  if (open) setMoreView('menu');
                }}
                trigger={
                  <IconButton variant="ghost" size="sm" aria-label="Player options">
                    <EllipsisVertical size={18} />
                  </IconButton>
                }
              >
                <div className="morePopover">
                  {moreView === 'menu' && (
                    <div className="moreMenu">
                      <button
                        type="button"
                        className="moreMenuItem"
                        onClick={() => setMoreView('eq')}
                      >
                        <AudioLines size={16} />
                        Equalizer
                      </button>
                      {/* Filing the song that is playing, without going to
                          find its row in the table first. The dialog wants the
                          whole sheet, so the pick leaves the popover. */}
                      {track && (
                        <button
                          type="button"
                          className="moreMenuItem"
                          onClick={() => {
                            setMoreOpen(false);
                            setFiling(track);
                          }}
                        >
                          <ListPlus size={16} />
                          Add to playlist
                        </button>
                      )}
                      {devicesAvailable && (
                        <button
                          type="button"
                          className="moreMenuItem"
                          onClick={() => setMoreView('devices')}
                        >
                          <MonitorSpeaker size={16} />
                          Connect to a device
                        </button>
                      )}
                    </div>
                  )}
                  {moreView !== 'menu' && (
                    <button
                      type="button"
                      className="moreBack"
                      onClick={() => setMoreView('menu')}
                    >
                      <ChevronLeft size={14} />
                      {moreView === 'devices' ? 'Devices' : 'Equalizer'}
                    </button>
                  )}
                  {moreView === 'eq' && (
                    <div className="eqPopover">
                      <EqPanel />
                    </div>
                  )}
                  {moreView === 'devices' && <DeviceList />}
                </div>
              </Popover>
              <VolumeControl
                value={volume}
                muted={muted}
                onValueChange={setVolumeState}
                onMutedChange={setMutedState}
              />
            </>
          )
        }
        // The shadow trailing the beat under the played run; nothing is drawn
        // without a beat to trail, so it is safe to leave on.
        tracer
        // The bar moves as hard as the station is playing.
        intensity={beatIntensity(volume, muted, systemVolume)}
      />
      </div>

      {/* The full-screen Now Playing surface, on touch only. Portalled to the
          body so its stacking is the viewport's, not the mini-strip's plate
          (which sits below the nav bar) - otherwise the nav would paint over
          it. It reuses every handler the strip does, so the two never diverge. */}
      {mobileControls && (npOpen || npDocked) && createPortal(
        <div
          className="npScreen"
          role="dialog"
          aria-label="Now playing"
          // Always the dark palette, whatever the app wears: this surface lives
          // over album art and its own backdrop, where light-theme ink is
          // unreadable and the lyric layers (white + screen-blend) vanish.
          // The token layer scopes [data-theme] on any element, so one
          // attribute re-themes the whole subtree.
          data-theme="dark"
          data-open={npOpen || undefined}
          data-docked={npDocked || undefined}
          // Capture phase, so ANY touch on the sheet - a control, the art, the
          // veil itself - counts as activity: the dim lifts and its clock
          // restarts. The veil below swallows its own tap so a wake-up touch
          // never also presses whatever sat under it.
          onPointerDownCapture={() => {
            setNpDimmed(false);
            if (playing) pokeNpDim();
          }}
        >
          {/* The song's own cover, blown up and blurred, as the surface behind
              the controls - the same move the mini-strip's backdrop makes,
              scoped to this sheet. */}
          <div
            className="npScreen__bg"
            aria-hidden="true"
            style={artwork ? { backgroundImage: `url(${JSON.stringify(artwork)})` } : undefined}
          />
          {/* The Spotify Canvas, when the track has one: a muted loop over this
              sheet's blurred cover, keyed on its URL so a new clip restarts
              cleanly. Absent - the common case - it is simply not rendered and
              the cover shows instead. Wrapped in the same artwork-style
              chooser the art carries, so a press-and-hold on the clip itself
              offers the switch - the one that matters most here, since
              'hidden' leaves the clip as the only thing to press. */}
          {npCanvas ? (
            <ContextMenu
              aria-label="Artwork style"
              className="npScreen__canvasWrap"
              content={npArtMenu}
            >
              <video
                key={npCanvas}
                className="npScreen__canvas"
                src={npCanvas}
                autoPlay
                loop
                muted
                playsInline
                aria-hidden="true"
              />
            </ContextMenu>
          ) : artView === 'hidden' ? (
            // No clip and no art: the sheet's open middle still answers the
            // press-and-hold, so 'hidden' is never a state you need the mini
            // strip to climb back out of.
            <ContextMenu
              aria-label="Artwork style"
              className="npScreen__canvasWrap"
              content={npArtMenu}
            />
          ) : null}
          {/* The lyric words run the full height of the sheet, behind the
              controls. Drawn AFTER the clip on purpose: a canvas is a backdrop,
              not a cover, and the words are the thing worth reading over it. */}
          <NowPlayingBackdrop wordsOnly artwork={artwork ?? npPlaceholderArt} seed={track?.path ?? 'np'} />
          {/* A blur that rises through the bottom third, so the transport, the
              times and the title read against something settled instead of
              against whatever frame the clip happens to be on. Sits over the
              canvas and the words, under every control. */}
          <div className="npScreen__veil" aria-hidden="true" />
          <header className="npScreen__head">
            <IconButton
              variant="ghost"
              aria-label="Close now playing"
              onClick={() => {
                setNpOpen(false);
                setNpLyrics(false);
              }}
            >
              <ChevronDown size={22} />
            </IconButton>
            <span className="npScreen__source">{track?.album || 'Now playing'}</span>
            {/* Where the close button's counterweight was: filing the song is
                the one action worth a permanent seat up here, and this sheet
                has the room the mini-strip's rail does not. */}
            {track ? (
              <IconButton
                variant="ghost"
                aria-label="Add to playlist"
                onClick={() => setFiling(track)}
              >
                <ListPlus size={20} />
              </IconButton>
            ) : (
              <span className="npScreen__headSpacer" aria-hidden="true" />
            )}
          </header>

          {/* The artwork, per the chosen face - and no longer standing down
              for a Canvas: the disc turns OVER the clip now, because the
              platter is an instrument (scratch, flick) and an instrument that
              vanishes when a video shows up is a broken promise. Anyone who
              prefers the clip unobstructed picks Hidden - the third face. */}
          {artView !== 'hidden' && (
          <div className="npScreen__art">
            {/* The hero art follows the same artView the mini-strip does, so the
                choice is one setting in two places. A press (long-press on
                touch) opens the chooser. */}
            <ContextMenu
              aria-label="Artwork style"
              className="npScreen__coverTarget"
              content={npArtMenu}
            >
              {artView === 'cd' ? (
                <SpinningDisc
                  art={dispArtwork}
                  spinning={activeElsewhere ? dispPlaying : audible}
                  spooling={buffering || downloading}
                  beat={beat}
                  onScratchStart={onScratchBegin}
                  onScratch={onScratch}
                  onScratchEnd={onScratchEnd}
                  
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
              ) : (
                <img
                  className="npScreen__cover"
                  src={artwork ?? npPlaceholderArt}
                  alt=""
                />
              )}
            </ContextMenu>
          </div>
          )}

          <div className="npScreen__meta">
            <div className="npScreen__lines">
              <span className="npScreen__title">{track?.title ?? ''}</span>
              {onOpenArtist && track ? (
                <button
                  type="button"
                  className="npScreen__artist npScreen__artistLink"
                  onClick={() => {
                    // The page opens under the sheet, so the sheet steps aside.
                    setNpOpen(false);
                    onOpenArtist(track.artist);
                  }}
                >
                  {track.artist}
                </button>
              ) : (
                <span className="npScreen__artist">{track?.artist ?? ''}</span>
              )}
              {chapterLabel && <span className="npScreen__chapter">{chapterLabel}</span>}
              {/* A downloading placeholder says so; otherwise only while the
                  buffer is actually dry - silence with the transport still
                  showing play is the mystery this whole path exists to end. */}
              {(downloading || buffering) && (
                <span className="npScreen__buffering" role="status">
                  {downloading ? 'Downloading…' : 'Buffering…'}
                </span>
              )}
            </div>
            <IconButton
              variant="ghost"
              aria-label={favorite ? 'Remove from favourites' : 'Add to favourites'}
              aria-pressed={favorite}
              className="npScreen__heart"
              onClick={toggleFavoriteFelt}
            >
              <Heart size={22} fill={favorite ? 'currentColor' : 'none'} />
            </IconButton>
          </div>

          {/* No scrubber while downloading - there is no timeline yet. */}
          {!downloading && (
          <div className="npScreen__scrub">
            {/* The kit's live bar, not a plain slider: the same waveform the
                mini strip wears, driven by the same levels and beat, so the
                now-playing screen deforms in time with the music. Pushed toward
                the hero end of the intensity range (max 3) since this bar IS
                the surface's focus, and set on a raised-card rail so the run
                ahead stays legible over the blurred cover behind it. */}
            <SeekBar
              duration={Math.max(1, duration)}
              value={position}
              aria-label="Seek"
              shape="swell"
              tone="accent"
              fill="solid"
              rail="contrast"
              levels={levels}
              beat={beat}
              tracer
              intensity={Math.min(3, beatIntensity(volume, muted, systemVolume) * 1.6)}
              onValueChange={onScrub}
              onSeekEnd={commitSeek}
            />
            <div className="npScreen__times">
              <span>{formatClock(position)}</span>
              <span>-{formatClock(Math.max(0, duration - position))}</span>
            </div>
          </div>
          )}

          <div className="npScreen__transport">
            <IconButton
              variant="ghost"
              aria-label="Shuffle"
              aria-pressed={shuffle}
              data-on={shuffle || undefined}
              onClick={() => setShuffle((s) => !s)}
            >
              <Shuffle size={20} />
            </IconButton>
            <IconButton variant="ghost" aria-label="Previous" disabled={!canSkip} onClick={skipBack}>
              <SkipBack size={26} fill="currentColor" />
            </IconButton>
            <button
              type="button"
              className="npScreen__play"
              aria-label={downloading ? 'Downloading' : playing ? 'Pause' : 'Play'}
              disabled={downloading}
              onClick={() => setPlayingState(!playing)}
            >
              {playing ? <Pause size={30} fill="currentColor" /> : <Play size={30} fill="currentColor" />}
            </button>
            <IconButton variant="ghost" aria-label="Next" disabled={!canSkip} onClick={skipForward}>
              <SkipForward size={26} fill="currentColor" />
            </IconButton>
            <IconButton
              variant="ghost"
              aria-label={`Repeat: ${repeat}`}
              data-on={repeat !== 'off' || undefined}
              onClick={cycleRepeat}
            >
              {repeat === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
            </IconButton>
          </div>

          {/* The secondary controls the strip has no room for: lyrics, the
              device hand-off (only when there is somewhere to send it), the
              equalizer, and the volume fader. The transport above already
              carries shuffle/repeat/skip, and favourite and filing sit on the
              meta and header rows. */}
          <div className="npScreen__actions">
            <IconButton variant="ghost" aria-label="Queue" onClick={() => setNpQueue(true)}>
              <ListMusic size={20} />
            </IconButton>
            <IconButton variant="ghost" aria-label="Lyrics" onClick={() => setNpLyrics(true)}>
              <Mic size={20} />
            </IconButton>
            <DevicePicker />
            <Popover
              placement="top"
              aria-label="Equalizer"
              className="eqPopoverPanel"
              trigger={
                <IconButton variant="ghost" aria-label="Equalizer">
                  <AudioLines size={20} />
                </IconButton>
              }
            >
              <div className="eqPopover">
                <EqPanel narrow={narrowEq} />
              </div>
            </Popover>
            {/* No fader on a phone: volume is pinned at unity there and the
                handset's own buttons are the control, so a slider that cannot
                move would be a lie. Desktop, which has no hardware keys of its
                own, keeps it. */}
            {!isMobile && (
              <Popover
                placement="top"
                aria-label="Volume"
                className="morePopoverPanel"
                trigger={
                  <IconButton variant="ghost" aria-label="Volume">
                    <Volume2 size={20} />
                  </IconButton>
                }
              >
                <VolumeRow
                  value={volume}
                  muted={muted}
                  onValueChange={setVolumeState}
                  onMutedChange={setMutedState}
                />
              </Popover>
            )}
          </div>

          {/* Lyrics fill the whole sheet rather than a low popover: a header to
              step back to the art, and the words scrolling below it. */}
          {npLyrics && (
            <div
              className="npScreen__lyricsScrim"
              aria-hidden="true"
              onPointerDown={() => setNpLyrics(false)}
            />
          )}
          {npLyrics && (
            <div className="npScreen__lyricsView" role="dialog" aria-label="Lyrics">
              <header className="npScreen__lyricsHead">
                <span className="npScreen__lyricsTitle">{track?.title ?? 'Lyrics'}</span>
                <IconButton variant="ghost" aria-label="Close lyrics" onClick={() => setNpLyrics(false)}>
                  <ChevronDown size={22} />
                </IconButton>
              </header>
              <div className="npScreen__lyricsBody">
                <LyricsPanel
                  key={(track ?? IDLE_TRACK).path}
                  track={track ?? IDLE_TRACK}
                  position={position}
                  onSeek={commitSeek}
                />
              </div>
            </div>
          )}
          {/* The queue, over the same sheet the same way: what plays next, drag-
              reorderable, each row a jump. */}
          {npQueue && (
            <div
              className="npScreen__lyricsScrim"
              aria-hidden="true"
              onPointerDown={() => setNpQueue(false)}
            />
          )}
          {npQueue && (
            <div className="npScreen__queueView">
              <QueuePanel
                queue={queue}
                current={track}
                onQueueChange={(next) => onQueueChange?.(next)}
                onPlayTrack={(t) => onTrackChange?.(t)}
                onClose={() => setNpQueue(false)}
              />
            </div>
          )}
          {/* The inactivity veil: near-black, fading in over everything on
              this sheet. It takes pointer events only while dimmed, so the
              waking tap lands here and nowhere else. */}
          <div
            className="npScreen__dim"
            data-dim={npDimmed || undefined}
            aria-hidden="true"
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
          />
        </div>,
        document.body,
      )}

      {/* One sheet for both phone entry points - the strip's overflow and the
          Now Playing header - so the same panel answers either. */}
      <AddToPlaylistDialog track={filing} open={filing !== null} onClose={() => setFiling(null)} />
    </>
  );
}

/** mm:ss for the Now Playing clock. */
function formatClock(seconds: number): string {
  // A deck reports Infinity (transcode stream) or NaN duration until metadata
  // lands, and Math.max(0, ...) passes both through - show the zero clock
  // instead of "Infinity:NaN".
  if (!Number.isFinite(seconds)) return '0:00';
  const t = Math.max(0, Math.floor(seconds));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
}
