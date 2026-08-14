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
}

declare global {
  interface Window {
    AFMNative?: NativeBridge;
    /** Called BY MainActivity when audio focus moves. */
    __AFM_AUDIO_FOCUS__?: (event: 'pause' | 'resume') => void;
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
