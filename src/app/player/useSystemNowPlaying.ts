import { useEffect, useRef, type MutableRefObject } from 'react';
import { isIOS } from '../core/platform.ts';
import { onCarPlayRemote, pushCarPlayNowPlaying } from './carplay.ts';
import {
  bindMediaSessionHandlers,
  updateMediaSessionMetadata,
  updateMediaSessionState,
} from './mediaSession.ts';
import {
  bindAudioFocus,
  bindNativeTransport,
  setNativeArtwork,
  setNativeNowPlaying,
  setNativePlaybackState,
  setNativePlaying,
} from './androidAudio.ts';
import { notePlaybackAudible } from '../downloads/autoCache.ts';
import type { Track } from '../core/tauri.ts';

/** The handles a system transport steers the player through - the Player
 *  reassigns `carPlayControls.current` to these EVERY render, so the
 *  mount-once listeners here always act through fresh closures. */
export interface SystemTransportControls {
  setPlaying: (next: boolean) => void;
  next: () => void;
  previous: () => void;
  seek: (to: number) => void;
}

/**
 * The OS-transport side channel: CarPlay, the media session (lock screen /
 * Control Center), and Android's foreground-service + focus + MediaSession
 * bindings. Extracted from Player.tsx; the Player assigns
 * `carPlayControls.current` each render and shares `positionRef` with its
 * other side channels.
 */
export function useSystemNowPlaying({
  track,
  playing,
  position,
  coarsePosition,
  duration,
  artwork,
  audible,
}: {
  track: Track | null;
  playing: boolean;
  position: number;
  coarsePosition: number;
  duration: number;
  artwork: string | null;
  audible: boolean;
}): {
  carPlayControls: MutableRefObject<SystemTransportControls | null>;
  positionRef: MutableRefObject<number>;
} {
  // ── CarPlay / system now-playing ─────────────────────────────────────────
  //
  // The native side (carplay.m) owns MPNowPlayingInfoCenter and the remote
  // command center; this feeds it and obeys it. Pushes go out only on
  // discontinuities - track change, play/pause, seek - because iOS runs the
  // clock itself from position + rate; obeying happens through one mount-once
  // listener that reads the latest controls through a ref, since the control
  // functions below are rebuilt every render and the listener is not.
  const carPlayControls = useRef<SystemTransportControls | null>(null);
  const positionRef = useRef(position);
  positionRef.current = position;
  const playingLiveRef = useRef(playing);
  playingLiveRef.current = playing;
  // Where the last push left the clock, so a seek (a jump the extrapolated
  // clock cannot have made) is recognisable against ordinary playback.
  const carPlaySentPos = useRef(-10);
  /** Which song's cover last crossed the native bridge. */
  const artSentFor = useRef<string | null>(null);

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
    // The cover crosses the bridge once per SONG, not once per effect run -
    // this effect also fires on play/pause and duration-learn, and re-sending
    // a shrunk jpeg on every pause is pure waste (the native side keeps the
    // bitmap until a different song is published, then clears it itself).
    if (artSentFor.current !== track.path) {
      artSentFor.current = track.path;
      setNativeArtwork(artwork?.startsWith('http') ? artwork : null);
    }
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

  return { carPlayControls, positionRef };
}
