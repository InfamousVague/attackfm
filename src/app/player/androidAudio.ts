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
  setArtwork?: (base64: string) => void;
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

/**
 * The cover, shrunk and handed over as bytes.
 *
 * The native side prints the song's words on the lock screen and the
 * notification, but a media session without METADATA_KEY_ALBUM_ART draws a
 * grey square there - the system never sees the web layer's art. This
 * fetches the cover the app is already showing (same cache, same auth),
 * shrinks it to system size, and sends it across as base64: the bridge
 * stays a string pipe and Kotlin never grows a network stack.
 *
 * Art loads race skips: only the newest request is allowed to land, so a
 * fast next-next-next cannot dress the current song in an old sleeve.
 * (The native side also clears art whenever a different song is published,
 * so the failure mode of a dropped send is a missing cover, never a wrong
 * one.)
 */
let artGeneration = 0;
export function setNativeArtwork(url: string | null): void {
  if (!window.AFMNative?.setArtwork) return;
  const mine = ++artGeneration;
  if (!url) return;
  void (async () => {
    try {
      const blob = await (await fetch(url)).blob();
      const bitmap = await createImageBitmap(blob);
      const side = Math.min(512, Math.max(bitmap.width, bitmap.height));
      const scale = side / Math.max(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      if (mine !== artGeneration) return;
      const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      if (base64) window.AFMNative?.setArtwork?.(base64);
    } catch {
      // A cover that fails to fetch or decode just stays off the lock screen.
    }
  })();
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
interface TransportHandlers {
  play?: () => void;
  pause?: () => void;
  next?: () => void;
  previous?: () => void;
  seek?: (seconds: number) => void;
  /** A collection tapped in the car's browse list: 'liked' | 'all' | 'shuffle'. */
  playCollection?: (id: string) => void;
}

/*
 * Several binders, not one.
 *
 * This used to assign `window.__AFM_TRANSPORT__` outright, which forced every
 * command to be answered by a single component - and the only component
 * holding the transport controls is the Player, which PlayerHost does not
 * mount until something is already playing. So in a car, from cold, the browse
 * list drew its three rows, a tap travelled the whole chain correctly, and
 * arrived at a global that did not exist yet. Every row dead until you had
 * already started something by hand, which is the one thing a dashboard is for
 * not making you do.
 *
 * A set of partial handlers lets the piece that is ALWAYS mounted answer for
 * the collections while the Player answers for the transport, without either
 * clobbering the other on mount order.
 */
const bound = new Set<TransportHandlers>();

export function bindNativeTransport(handlers: TransportHandlers): () => void {
  bound.add(handlers);
  window.__AFM_TRANSPORT__ = (command) => {
    for (const h of bound) {
      if (command === 'play') h.play?.();
      else if (command === 'pause') h.pause?.();
      else if (command === 'next') h.next?.();
      else if (command === 'previous') h.previous?.();
      else if (command.startsWith('seek:')) {
        const secs = Number(command.slice(5));
        if (Number.isFinite(secs)) h.seek?.(secs);
      } else if (command.startsWith('collection:')) {
        h.playCollection?.(command.slice('collection:'.length));
      }
    }
  };
  return () => {
    bound.delete(handlers);
    if (bound.size === 0) delete window.__AFM_TRANSPORT__;
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
