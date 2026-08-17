import { useEffect, useRef, useState } from 'react';
import { fetchCanvas, trackIdFromPath, type ServerSession } from '../server.ts';
import { setIdleTimerDisabled } from './carplay.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Now Playing sheet housekeeping with no audio coupling, extracted from
 * Player.tsx: the inactivity dim veil + idle-timer keepAwake, the
 * return-to-app-opens-Now-Playing move, and the Spotify Canvas clip fetch.
 */
export function useNpChrome({
  npOpen,
  playing,
  mobileControls,
  audible,
  remoteOnly,
  track,
  playSession,
  setNpOpen,
}: {
  npOpen: boolean;
  playing: boolean;
  mobileControls: boolean;
  audible: boolean;
  remoteOnly: boolean;
  track: Track | null;
  playSession: ServerSession | null;
  setNpOpen: (open: boolean) => void;
}): {
  npDimmed: boolean;
  setNpDimmed: (next: boolean) => void;
  pokeNpDim: () => void;
  npCanvas: string | null;
} {
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

  // The playing track's Spotify Canvas (a short looping clip), when the server
  // is set up to fetch one and the track has one. Null the rest of the time,
  // and on every track change until the next answer lands, so a clip never
  // lingers over the wrong song. Only fetched while the full sheet is open.
  const [npCanvas, setNpCanvas] = useState<string | null>(null);
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

  return { npDimmed, setNpDimmed, pokeNpDim, npCanvas };
}
