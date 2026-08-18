import { clearEnhancers, nextEnhancer, primeEnhancers } from './smartShuffle.ts';
import { trackIdFromPath } from '../server.ts';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  createAnalyserMeter,
  volumeAmplitude,
  useToast,
} from '@glacier/react';
import type { AnalyserMeter, LoudnessMeter, PlayerRepeat } from '@glacier/react';
import { isIOS, isMobile } from '../core/platform.ts';
import { useLibrary } from '../library/library.tsx';
import { useEqualizer } from './equalizer.tsx';
import { usePlayback } from './playback.tsx';
import { useNowPlayingMotion } from './nowPlayingMotion.tsx';
import { VOLUME_UNITY } from './VolumeControl.tsx';
import { useEffects } from './effects.ts';
import { useFxChain } from './fxChain.ts';
import { loadAudioUrl, reactivateAudioSession, systemOutputVolume, type Track } from '../core/tauri.ts';
import { isPendingPath } from './pendingPlay.tsx';
import { isRemotePath } from '../server.ts';
import { fireNativeHaptic } from '../core/haptics.ts';
import { loadScrubTape } from './scrubTape.ts';
import { useConnect } from './playbackSync.tsx';
import { AddToPlaylistDialog } from '../playlists/AddToPlaylist.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useJamOptional } from './jam.tsx';
import { useSystemBack } from '../nav/systemBack.ts';
import { usePlayerDismiss } from './playerDismiss.ts';
import { initDockWave } from './dockWave.ts';
import { useMediaQuery } from '../ux/useMediaQuery.ts';
import { REDUCED_MOTION_QUERY } from '../ux/useReducedMotion.ts';
import {
  FADE_DOWN_MS,
  FADE_UP_MS,
  ART_VIEW_KEY,
  CATCH_FLUSH_MS,
  IDLE_TRACK,
  INITIAL_VOLUME,
  MOBILE_PLAYER_QUERY,
  RATE_FLOOR,
  SPIN_DOWN_MS,
  SPIN_UP_FADE_MS,
  SPIN_UP_MS,
  TRACK_ART,
  readArtView,
  readDeckPref,
  timelineDuration,
  writeDeckPref,
  type ArtView,
} from './deckShared.ts';
import { useSystemNowPlaying } from './useSystemNowPlaying.ts';
import { useListenReporting } from './useListenReporting.ts';
import { useNpChrome } from './useNpChrome.ts';
import { usePlayerConnect, type PlayerLiveState } from './usePlayerConnect.ts';
import { NowPlayingSheet, npArtMenuItems } from './NowPlayingSheet.tsx';
import { PlayerStrip } from './PlayerStrip.tsx';

/**
 * The station strip along the bottom of the window. The kit's PlayerBar owns
 * the layout and every control; this owns the audio element, keeps the two in
 * step, and walks the queue: the list the playing track was opened from, in
 * the order it was showing. Skips and the end of a track resolve their target
 * here, where the bar's shuffle and repeat toggles live, and the chosen track
 * is handed up through onTrackChange rather than loaded directly - the app
 * owns what is playing; this owns what comes next.
 *
 * Split for size: the pure constants live in deckShared.ts, the presentation
 * in PlayerStrip.tsx / NowPlayingSheet.tsx / LyricsPanel.tsx, and the side
 * channels in useSystemNowPlaying / useListenReporting / useNpChrome /
 * usePlayerConnect. The audio deck core - the closure web over the shared
 * refs - deliberately stays here whole.
 */
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
  /*
   * Shuffle has three states now, not two: off, on, and smart.
   *
   * `shuffle` stays a boolean so every consumer of it - pickNext, the strip,
   * the sheet, Connect - keeps working untouched; `smart` rides alongside and
   * only means anything while shuffle is on. Stored as one pref so an old
   * build reading 'on' still finds shuffle on.
   */
  const [shuffle, setShuffle] = useState(() => {
    const stored = readDeckPref('shuffle');
    return stored === 'on' || stored === 'smart';
  });
  const [smart, setSmart] = useState(() => readDeckPref('shuffle') === 'smart');
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
  useEffect(
    () => writeDeckPref('shuffle', shuffle ? (smart ? 'smart' : 'on') : 'off'),
    [shuffle, smart],
  );

  // Read by pickNext, which must not re-create itself when the mode flips.
  const enhanceStep = useRef(0);
  const smartRef = useRef(smart);
  smartRef.current = smart;

  /** off -> shuffle -> smart shuffle -> off. One control, three answers. */
  const cycleShuffle = useCallback(() => {
    if (!shuffle) {
      setShuffle(true);
      setSmart(false);
    } else if (!smart) {
      setSmart(true);
    } else {
      setShuffle(false);
      setSmart(false);
    }
    enhanceStep.current = 0;
  }, [shuffle, smart]);
  useEffect(() => writeDeckPref('repeat', repeat), [repeat]);
  useEffect(() => {
    if (!isMobile) writeDeckPref('volume', String(Math.round(volume)));
  }, [volume]);

  // The strip is built from the music list, so there is nothing settled to show
  // until the folder is resolved and its files have been walked. The whole bar
  // loads as a skeleton until then.
  const { loading: libraryLoading, scanning, isFavorite, toggleFavorite, tracks: libraryTracks } = useLibrary();
  const { toast } = useToast();
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
  // way IN. Un-hearting stays silent in the hand but leaves a way back on
  // screen: the heart is small, the thumb is not, and a like taken by
  // accident should cost one tap rather than a hunt through the library.
  const toggleFavoriteFelt = () => {
    if (!track) return;
    const path = track.path;
    if (!favorite) fireNativeHaptic('success');
    toggleFavorite(path);
    if (favorite) {
      toast({
        message: `Removed “${track.title}” from Liked`,
        action: { label: 'Undo', onPress: () => toggleFavorite(path) },
      });
    }
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
  // setting no matter where the press lands. (Items live in NowPlayingSheet.)
  const npArtMenu = npArtMenuItems(artView, chooseArtView);

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
  // The overflow popover state now lives in PlayerStrip.
  // The song being filed into a playlist, or null when that sheet is shut.
  const [filing, setFiling] = useState<Track | null>(null);
  // The full-screen Now Playing surface, opened by tapping the strip on touch.
  const [npOpen, setNpOpen] = useState(false);
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
  // The dim veil, the return-to-app move and the Canvas fetch live in
  // useNpChrome, called below once `audible` and the play session exist.
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
    if (window.matchMedia?.(REDUCED_MOTION_QUERY).matches) return;
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
  // The hi-fi chain re-colours in place by the same mechanism. Object identity
  // is the change signal, same as the rack's array identity.
  const chain = useFxChain();
  const rackWas = useRef(rack);
  const chainWas = useRef(chain);
  useEffect(() => {
    const beforeRack = rackWas.current;
    const beforeChain = chainWas.current;
    rackWas.current = rack;
    chainWas.current = chain;
    if (beforeRack === rack && beforeChain === chain) return;
    if (!liveRef.current.track || !isRemotePath(liveRef.current.track.path)) return;
    resumeCount.current = 0;
    void resumeInPlace();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rack and chain are the triggers; resumeInPlace is redefined every render
  }, [rack, chain]);

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

  // `progress` is where a hit lands on the bar, so ripples leave the playhead
  // rather than a fixed point.
  const progress = duration > 0 ? position / duration : 0;
  // The analyser now reads full-scale regardless of the fader, so the bar would
  // keep moving even while silenced; freeze it when muted or on the floor so
  // "nothing coming out" still reads as "nothing moving".
  const audible = playing && !muted && volume > 0;
  // The beat and the live levels are NOT subscribed here. The kit's useBeat
  // sets a fresh object every animation frame while music is audible, and
  // this component - 2,500 lines, mounted app-wide - re-rendering at 60fps
  // was the single largest drag on scrolling anything while playing. The
  // strip and the sheet, the only surfaces that draw the pulse, each run the
  // hooks themselves off the meter below.


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

  /*
   * The enhancer pool follows the queue. Primed on a queue change rather than
   * at pick time because a track change is the worst possible moment to wait
   * on a network round trip; by the time shuffle reaches for one it is already
   * in hand. Cleared whenever the mode is off, so nothing stale survives a
   * toggle.
   */
  useEffect(() => {
    if (!shuffle || !smart) {
      clearEnhancers();
      return;
    }
    void primeEnhancers(
      playSession,
      queue,
      (id) => libraryTracks.find((t) => trackIdFromPath(t.path) === id),
      (path) => trackIdFromPath(path),
    );
  }, [shuffle, smart, queue, playSession, libraryTracks]);
  const playSessionRef = useRef(playSession);
  playSessionRef.current = playSession;
  const renewSessionRef = useRef(renewSession);
  renewSessionRef.current = renewSession;

  // The Now Playing sheet's housekeeping: the dim veil, the return-to-app
  // move, and the Canvas clip fetch. No audio coupling - see useNpChrome.
  const { npDimmed, setNpDimmed, pokeNpDim, npCanvas } = useNpChrome({
    npOpen,
    playing,
    mobileControls,
    audible,
    remoteOnly,
    track,
    playSession,
    setNpOpen,
  });

  // CarPlay, the media session and Android's transport bindings - see
  // useSystemNowPlaying. carPlayControls.current is reassigned every render
  // further down (after the handlers exist) so the hook's mount-once
  // listeners always act through fresh closures; positionRef is shared with
  // the other side channels here.
  const { carPlayControls, positionRef } = useSystemNowPlaying({
    track,
    playing,
    position,
    coarsePosition,
    duration,
    artwork,
    audible,
  });

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
        if (isActive()) {
          setDuration(timelineDuration(audio.duration, liveRef.current.track?.duration));
        }
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
      // Seed the timeline from the indexed metadata immediately. Android may
      // later describe a streamed response as infinitely long; onMeta keeps
      // this finite value instead of replacing it with that sentinel.
      setDuration(timelineDuration(0, track.duration));
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
          analyserRef.current.rampVolume(currentAmplitude(), FADE_UP_MS / 1000);
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
          analyserRef.current.rampVolume(0, FADE_DOWN_MS / 1000);
          window.setTimeout(() => {
            if (token !== rampToken.current) return;
            park(audio);
          }, FADE_DOWN_MS + 20);
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
      /*
       * Smart shuffle spends an enhancer on every fourth step: a song the
       * server says belongs in this queue but is not in it. Counted, not
       * rolled - a coin flip clusters, and two enhancers back to back would
       * read as the app taking the queue over rather than adding to it.
       */
      if (playbackRef.current.smartShuffle && smartRef.current) {
        const extra = nextEnhancer(enhanceStep.current, new Set(recentRef.current));
        enhanceStep.current += 1;
        if (extra) return extra;
      } else {
        enhanceStep.current = 0;
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
        setDuration(timelineDuration(nowActive.duration, flight.next.duration));
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
        setDuration(timelineDuration(nowActive.duration, warm.next.duration));
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

  // The listening log - play counts, listen events, and the audiobook
  // bookmark - reads the deck through the same refs the deck writes; see
  // useListenReporting. Called here so commitSeek exists to hand it.
  useListenReporting({
    track,
    playing,
    audible,
    duration,
    coarsePosition,
    playSession,
    playSessionRef,
    scrubbing,
    playbackRef,
    positionRef,
    commitSeek,
  });

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
  // The Connect / jam seam itself lives in usePlayerConnect; what stays here
  // is the ref it acts through. (connect is read near the top of the
  // component - see remoteOnly.)
  // The controller is registered once but must act through the current render's
  // handlers and values, so it reaches them all through this ref.
  const liveRef = useRef<PlayerLiveState>({
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
  // remembered seek+play is applied once it has actually loaded (in the hook).
  const resumeRef = useRef<{ trackId: number; positionMs: number; play: boolean } | null>(null);

  const { remoteTrack, activeDeviceName, remotePosition } = usePlayerConnect({
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
  });

  // Playback lives on another device: this one is a remote. It shows that
  // device's now-playing (resolved from the library) and its transport sends
  // commands rather than driving local audio.
  const activeElsewhere = remoteOnly;

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
      {/* The docked strip, extracted whole into PlayerStrip: same shell, same
          PlayerBar, every handler passed down. */}
      <PlayerStrip
        shellRef={shellRef}
        dismissed={dismissed}
        mobileControls={mobileControls}
        openNowPlaying={openNowPlaying}
        listLoading={listLoading}
        npArtMenu={npArtMenu}
        artView={artView}
        track={track}
        artwork={artwork}
        dispArtwork={dispArtwork}
        activeElsewhere={activeElsewhere}
        activeDeviceName={activeDeviceName}
        dispTrack={dispTrack}
        dispDuration={dispDuration}
        dispPosition={dispPosition}
        dispPlaying={dispPlaying}
        audible={audible}
        buffering={buffering}
        downloading={downloading}
        meter={meter}
        progress={progress}
        pauseStyle={playback.pauseStyle}
        onScrubDisp={onScrubDisp}
        onSeekEndDisp={onSeekEndDisp}
        onPlayingChangeDisp={onPlayingChangeDisp}
        onSkipBackDisp={onSkipBackDisp}
        onSkipForwardDisp={onSkipForwardDisp}
        shuffle={shuffle}
        smart={smart}
        setShuffle={setShuffle}
        repeat={repeat}
        setRepeat={setRepeat}
        favorite={favorite}
        toggleFavoriteFelt={toggleFavoriteFelt}
        position={position}
        commitSeek={commitSeek}
        volume={volume}
        muted={muted}
        systemVolume={systemVolume}
        setVolumeState={setVolumeState}
        setMutedState={setMutedState}
        setNpQueue={setNpQueue}
        setNpOpen={setNpOpen}
        setFiling={setFiling}
      />

      {/* The full-screen Now Playing surface, on touch only - extracted whole
          into NowPlayingSheet (which portals itself to the body). It reuses
          every handler the strip does, so the two never diverge. */}
      {mobileControls && (npOpen || npDocked) && (
        <NowPlayingSheet
          npOpen={npOpen}
          npDocked={npDocked}
          npDimmed={npDimmed}
          setNpDimmed={setNpDimmed}
          pokeNpDim={pokeNpDim}
          npCanvas={npCanvas}
          npLyrics={npLyrics}
          setNpLyrics={setNpLyrics}
          npQueue={npQueue}
          setNpQueue={setNpQueue}
          setNpOpen={setNpOpen}
          npArtMenu={npArtMenu}
          artView={artView}
          track={track}
          artwork={artwork}
          dispArtwork={dispArtwork}
          activeElsewhere={activeElsewhere}
          dispPlaying={dispPlaying}
          playing={playing}
          audible={audible}
          buffering={buffering}
          downloading={downloading}
          meter={meter}
          progress={progress}
          pauseStyle={playback.pauseStyle}
          onScratchBegin={onScratchBegin}
          onScratch={onScratch}
          onScratchEnd={onScratchEnd}
          onOpenArtist={onOpenArtist}
          chapterLabel={chapterLabel}
          favorite={favorite}
          toggleFavoriteFelt={toggleFavoriteFelt}
          duration={duration}
          position={position}
          volume={volume}
          muted={muted}
          systemVolume={systemVolume}
          onScrub={onScrub}
          commitSeek={commitSeek}
          shuffle={shuffle}
          smart={smart}
          cycleShuffle={cycleShuffle}
          canSkip={canSkip}
          skipBack={skipBack}
          skipForward={skipForward}
          setPlayingState={setPlayingState}
          repeat={repeat}
          cycleRepeat={cycleRepeat}
          narrowEq={narrowEq}
          setVolumeState={setVolumeState}
          setMutedState={setMutedState}
          queue={queue}
          onQueueChange={onQueueChange}
          onTrackChange={onTrackChange}
          setFiling={setFiling}
        />
      )}

      {/* One sheet for both phone entry points - the strip's overflow and the
          Now Playing header - so the same panel answers either. */}
      <AddToPlaylistDialog track={filing} open={filing !== null} onClose={() => setFiling(null)} />
    </>
  );
}
