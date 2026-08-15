/**
 * The Android side of background playback.
 *
 * Android will not keep a backgrounded app's audio running on trust: it wants a
 * foreground service to say the process is doing something the listener chose,
 * and it wants the app to hold audio focus so it can be TOLD when navigation
 * needs the speaker for a moment. Neither exists in the web layer - both live in
 * MainActivity - so this is the thin line between them.
 *
 * `AFMNative` is injected by MainActivity (addJavascriptInterface) and is absent
 * everywhere else: iOS, the desktop, a browser tab. Every call here is a no-op
 * off Android, so callers need no platform test of their own.
 */

interface NativeBridge {
  setPlaying: (playing: boolean) => void;
  /** Present from 0.3.68; absent on an older shell, hence the optionals. */
  setNowPlaying?: (title: string, artist: string, album: string, durationMs: number) => void;
  setSyncing?: (active: boolean) => void;
  setPlaybackState?: (playing: boolean, positionMs: number) => void;
}

declare global {
  interface Window {
    AFMNative?: NativeBridge;
    /** Called BY MainActivity when audio focus moves. Dormant since 0.3.63 -
     *  the activity no longer requests focus (see attackfm-android-audio-focus). */
    __AFM_AUDIO_FOCUS__?: (event: 'pause' | 'resume') => void;
    /** Called BY MainActivity when a MediaSession or notification button is
     *  pressed: 'play' | 'pause' | 'next' | 'previous' | 'seek:<seconds>'. */
    __AFM_TRANSPORT__?: (command: string) => void;
  }
}

/**
 * Tell Android whether sound is coming out.
 *
 * Starting the service is only legal while the app is visible, which is exactly
 * when this is called - the listener has just pressed play. Stopping it when the
 * music stops matters as much: an ongoing notification over a silent app is a
 * lie, and Android is entitled to complain about a service that outlives its
 * reason.
 */
export function setNativePlaying(playing: boolean): void {
  try {
    window.AFMNative?.setPlaying(playing);
  } catch {
    // The bridge is one-way and best-effort; a failure here must never take
    // the deck down with it.
  }
}

/**
 * Obey the system when it needs the speaker.
 *
 * `pause` is a real interruption - a call, or another player taking over - and
 * `resume` is the system handing it back. A DUCK never reaches here: Android
 * lowers and restores the volume itself, and pausing for one is what makes a
 * spoken direction stop the music for good.
 *
 * The handlers are the player's own play/pause, so this steers the deck exactly
 * as a button would, and everything downstream (the strip, the notification,
 * the hub) follows as it always does.
 */
export function bindAudioFocus(handlers: {
  pause: () => void;
  resume: () => void;
}): () => void {
  window.__AFM_AUDIO_FOCUS__ = (event) => {
    if (event === 'pause') handlers.pause();
    else if (event === 'resume') handlers.resume();
  };
  return () => {
    delete window.__AFM_AUDIO_FOCUS__;
  };
}

/**
 * Tell Android what is playing, so everything outside the app can print it.
 *
 * `navigator.mediaSession` is the whole story on iOS - WKWebView hands the
 * page's session straight to the system. An Android WebView does not: Chromium
 * publishes a session for a browser TAB, not for a view embedded in someone
 * else's app. So on Android every one of those calls reached nothing, and the
 * lock screen, the notification and an Android Auto dashboard had no idea a
 * song existed. This is the same sentence, said to the half of the platform
 * that can hear it.
 */
export function setNativeNowPlaying(meta: {
  title: string;
  artist: string;
  album: string;
  durationSecs: number;
}): void {
  try {
    window.AFMNative?.setNowPlaying?.(
      meta.title,
      meta.artist,
      meta.album,
      Math.max(0, Math.round(meta.durationSecs * 1000)),
    );
  } catch {
    // Best-effort, exactly like the rest of this bridge.
  }
}

/** Whether it is playing and where, for the car's scrubber and the row's icon. */
export function setNativePlaybackState(playing: boolean, positionSecs: number): void {
  try {
    window.AFMNative?.setPlaybackState?.(playing, Math.max(0, Math.round(positionSecs * 1000)));
  } catch {
    // Same.
  }
}

/**
 * Obey the buttons that are not on this screen.
 *
 * A steering wheel, an Android Auto dashboard, the lock screen, the
 * notification's own row - all of them press the MediaSession, which lands in
 * the service, which calls this. The handlers are the player's own, so a press
 * out there steers the deck exactly as a press in here would and everything
 * downstream follows.
 */
export function bindNativeTransport(handlers: {
  play: () => void;
  pause: () => void;
  next: () => void;
  previous: () => void;
  seek: (seconds: number) => void;
}): () => void {
  window.__AFM_TRANSPORT__ = (command) => {
    if (command === 'play') handlers.play();
    else if (command === 'pause') handlers.pause();
    else if (command === 'next') handlers.next();
    else if (command === 'previous') handlers.previous();
    else if (command.startsWith('seek:')) {
      const secs = Number(command.slice(5));
      if (Number.isFinite(secs)) handlers.seek(secs);
    }
  };
  return () => {
    delete window.__AFM_TRANSPORT__;
  };
}

/**
 * Hold the process while the cache sweep downloads.
 *
 * Android freezes a backgrounded app that holds no foreground service, and a
 * frozen app's sockets die where they stand - which turned "tabbed away
 * mid-sweep" into 144 instant fetch failures. The playback service carries a
 * dataSync leg for exactly this window. No-op everywhere but Android.
 */
export function setNativeSyncing(active: boolean): void {
  try {
    window.AFMNative?.setSyncing?.(active);
  } catch {
    // Best-effort, like the rest of this bridge.
  }
}
