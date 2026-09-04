import { useEffect, useRef, useState } from 'react';
import { fetchCanvas, trackIdFromPath, type ServerSession } from '../server.ts';
import { autoDownloadAllowed, nowPlayingVideoEnabled } from '../settings/behaviourPrefs.ts';
import { cachedCanvas, keepCanvas } from '../cache/canvasCache.ts';
import { knownCanvasForm, playableCanvasUrl } from '../cache/cacheSweep.ts';
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
    // The switch is read here rather than around the effect so that turning it
    // off mid-song clears the clip on the next track change instead of leaving
    // the last one looping. A song with no clip already falls back to the
    // blurred cover, so off is a path the screen was always able to draw.
    if (!npOpen || !track || !playSession || !nowPlayingVideoEnabled()) return;
    /*
     * NEVER FOR A BOOK.
     *
     * A Canvas is looked up by title and artist, and a book has both - so
     * "Dungeon Crawler Carl" by "Matt Dinniman" matches something on Spotify
     * and a music video ends up looping behind a chapter of prose. It is not a
     * near-miss that needs a better match: a book has no Canvas to be right
     * about, so the only correct number of lookups is zero.
     *
     * Returning here leaves `npCanvas` null, which is the path the screen
     * already draws for a song without a clip - the cover, blurred, under the
     * read-along text. Nothing new has to work for this to look right.
     */
    if (track.kind === 'book') return;
    const controller = new AbortController();
    /*
     * THE HELD CLIP FIRST, off the sweep's own memo - no network in the path.
     *
     * The old order asked /api/canvas for the URL and only then looked in the
     * cache, so a phone in a tunnel with the clip ON DISK drew the blurred
     * cover instead: the lookup failed before the cache was ever consulted.
     * The sweep's canvas-known memo already records each track's stable clip
     * form (or that it has none), which is exactly the key the cache stores
     * under - so offline the whole chain works from localStorage and the
     * Cache API alone. A memo that says "no clip" also skips the ask, which
     * is a free lookup saved online too.
     */
    // Narrowed once for the closure below - TypeScript's narrowing does not
    // survive into a hoisted function declaration.
    const t = track;
    const sess = playSession;
    const remembered = knownCanvasForm(t.path);
    if (remembered === null) {
      setNpCanvas(null);
      return;
    }
    if (remembered) {
      void cachedCanvas(playableCanvasUrl(remembered, sess)).then((held) => {
        if (controller.signal.aborted) return;
        if (held) {
          setNpCanvas(held);
        } else {
          // Remembered but not held (evicted, or another device's memo shape):
          // fall through to the ordinary ask.
          askServer();
        }
      });
      return () => controller.abort();
    }
    askServer();
    function askServer() {
    void fetchCanvas(
      sess,
      t.title,
      t.artist,
      controller.signal,
      trackIdFromPath(t.path),
    ).then(async (url) => {
      if (controller.signal.aborted) return;
      if (!url) {
        setNpCanvas(null);
        return;
      }
      /*
       * The held copy first, and it is worth the wait for the lookup.
       *
       * A clip is megabytes, and the ones that matter are the songs played
       * often - which were being pulled down again every single time. A blob
       * out of the cache is bytes already in memory, so the <video> starts
       * from it without a Range request and the sheet opens with the clip
       * already running rather than catching up to itself.
       */
      const held = await cachedCanvas(url);
      if (controller.signal.aborted) return;
      if (held) {
        setNpCanvas(held);
        return;
      }
      /*
       * Not held, so this is a download - and on this screen it is one PER
       * SONG, because the effect runs again on every track change while the
       * sheet is open. Sitting on Now Playing over cellular was several
       * megabytes a song with the Wi-Fi switch turned on and promising
       * otherwise; opening the screen is you asking to see it, but it is not
       * you asking to fetch a video for every song that follows.
       *
       * Nulled rather than falling back to `url`, which is the trap here: the
       * fallback exists for a device with no Cache API, and handing the plain
       * URL to a <video> streams the same megabytes through the media stack
       * instead. Null is the path the screen already draws for a song with no
       * clip - the blurred cover - so nothing new has to work.
       */
      if (!(await autoDownloadAllowed())) {
        if (!controller.signal.aborted) setNpCanvas(null);
        return;
      }
      // Fetch it once, keep it, and play from those same bytes. The plain URL
      // is the fallback for a device with no Cache API and for a clip that
      // would not come down.
      const kept = await keepCanvas(url);
      if (!controller.signal.aborted) setNpCanvas(kept ?? url);
    })
      /* Unawaited, and it runs again on every track change while the sheet is
         open - so anything that throws in there (the lookup, the cache, the
         download) is an unhandled rejection once per song. A clip is
         decoration; not having one is the ordinary case. */
      .catch(() => {
        if (!controller.signal.aborted) setNpCanvas(null);
      });
    }
    return () => controller.abort();
  }, [npOpen, track?.title, track?.artist, track?.kind, playSession]);

  return { npDimmed, setNpDimmed, pokeNpDim, npCanvas };
}
