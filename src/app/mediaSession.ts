/**
 * The system now-playing surface, spoken natively from the webview.
 *
 * With playback running straight through the <audio> elements (the iPhone
 * default - see ensureMeter), WebKit itself claims the OS now-playing session
 * for the page, and its claim is the one that sticks: writes to
 * MPNowPlayingInfoCenter from our own native code get clobbered on the next
 * element event, and the lock screen's buttons drive the element directly -
 * which is how "pause" once turned into "pauses, then plays again" under the
 * background-recovery watchdog. This module feeds WebKit's claim instead of
 * fighting it: `navigator.mediaSession` metadata is what the lock screen,
 * Control Center, and CarPlay's Now Playing screen render, and its action
 * handlers are where their buttons land - inside the app's own transport,
 * where intent is recorded before anything pauses.
 *
 * This module is the claimant on EVERY platform, the iPhone included. An
 * earlier build tried the opposite split - native center on iOS, this module
 * elsewhere - on the theory that the WebAudio graph broke WebKit's claim; the
 * phone answered with the generic "AttackFM" card (WebKit's starved defaults:
 * page title, no artwork, ±10s skips) because WebKit held the claim anyway.
 * carplay.m's native push still runs alongside on iOS: the car's own templates
 * are fed from it, and it is the fallback for whenever WebKit holds no claim.
 */

export interface MediaSessionControls {
  play: () => void;
  pause: () => void;
  next?: () => void;
  previous?: () => void;
  seek?: (seconds: number) => void;
}

function session(): MediaSession | null {
  return typeof navigator !== 'undefined' && 'mediaSession' in navigator
    ? navigator.mediaSession
    : null;
}

/** Points the system's transport buttons at the app's own controls. */
export function bindMediaSessionHandlers(controls: MediaSessionControls): void {
  const media = session();
  if (!media) return;
  try {
    media.setActionHandler('play', () => controls.play());
    media.setActionHandler('pause', () => controls.pause());
    media.setActionHandler('nexttrack', controls.next ? () => controls.next?.() : null);
    media.setActionHandler('previoustrack', controls.previous ? () => controls.previous?.() : null);
    media.setActionHandler(
      'seekto',
      controls.seek
        ? (details) => {
            if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime)) {
              controls.seek?.(details.seekTime);
            }
          }
        : null,
    );
  } catch {
    // An engine that knows mediaSession but not an action name throws on
    // registration; the actions it does know keep working.
  }
}

/** What the lock screen prints: the song, and its cover when the URL is one
 * the system can fetch (the server's art URLs carry their own token). */
export function updateMediaSessionMetadata(meta: {
  title: string;
  artist: string;
  album: string;
  artwork: string | null;
}): void {
  const media = session();
  if (!media || typeof MediaMetadata === 'undefined') return;
  try {
    media.metadata = new MediaMetadata({
      title: meta.title,
      artist: meta.artist,
      album: meta.album,
      artwork: meta.artwork ? [{ src: meta.artwork }] : [],
    });
  } catch {
    // Metadata the engine refuses is a blank lock screen, not a crash.
  }
}

/** The clock: pushed on discontinuities only - iOS extrapolates in between. */
export function updateMediaSessionState(state: {
  duration: number;
  position: number;
  playing: boolean;
}): void {
  const media = session();
  if (!media) return;
  try {
    media.playbackState = state.playing ? 'playing' : 'paused';
    if (Number.isFinite(state.duration) && state.duration > 0) {
      media.setPositionState({
        duration: state.duration,
        position: Math.min(Math.max(state.position, 0), state.duration),
        playbackRate: 1,
      });
    }
  } catch {
    // A position the engine rejects (metadata race) just skips one update.
  }
}
