/**
 * Switches for work the app does on your behalf.
 *
 * Same shape as netPrefs: plain module functions, no React, because most of the
 * callers are not components - they are effects, schedulers and plain async
 * functions that want to read the answer at the moment they act rather than be
 * handed it through props.
 *
 * The rule these follow, and the reason they exist: if the app spends something
 * that is yours - GPU, disk, mobile data, or your listening habits leaving the
 * device - you should be able to find the switch for it. Every one of these was
 * previously either an environment variable nobody could reach from the app, or
 * nothing at all.
 */

/** Absent means the shipped behaviour; only an explicit mark turns it around. */
function on(key: string, fallbackOn: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallbackOn;
    return v !== 'off';
  } catch {
    return fallbackOn;
  }
}

function set(key: string, value: boolean, fallbackOn: boolean): void {
  try {
    // Storing only the side that differs from the default keeps the key absent
    // for anyone who never touched it, so a later change of default reaches
    // them rather than being frozen by a write they did not make.
    if (value === fallbackOn) localStorage.removeItem(key);
    else localStorage.setItem(key, value ? 'on' : 'off');
  } catch {
    // Storage refused: the choice holds for this run and not beyond it.
  }
}

// ── Where you are, sent to your account ─────────────────────────────────────

const RESUME_KEY = 'attackfm-share-position';

/**
 * Whether the player reports what you are playing to registry.attack.fm.
 *
 * OFF by default, which is a deliberate change rather than a preserved one.
 * The reporting shipped ungated: every twenty seconds, and on every track
 * change, the deck sent the song, artist, full path and position to a central
 * service - while the Playback pane told people "Off, nothing is written
 * anywhere" under a switch that never touched it. Worse, `fetchResume` has no
 * callers anywhere in the app, so the data went out and nothing has ever read
 * it back: a continuous outbound stream paying for a feature that does not
 * exist on screen yet.
 *
 * Default it on the day something actually offers to resume.
 */
export function sharePositionEnabled(): boolean {
  return on(RESUME_KEY, false);
}

export function setSharePosition(value: boolean): void {
  set(RESUME_KEY, value, false);
}

// ── Sending your music to a server ──────────────────────────────────────────

const UPLOAD_KEY = 'attackfm-auto-upload';

/**
 * Whether connecting to a server starts pushing this machine's music onto it.
 *
 * Per server, because the honest answer differs per server: it is obviously
 * right for your own hub and obviously wrong for a friend's, and the app cannot
 * tell them apart except by asking. Three seconds after connecting, the app
 * walks your folder, works out what that server lacks, and uploads it - and the
 * server accepts it from any signed-in account, not just an admin.
 *
 * Defaults to on where you are the admin, which is the app's best guess at
 * "this is my hub", and off everywhere else. `Sync folder now` is unaffected
 * either way, so turning it off costs only the automatic start.
 */
export function autoUploadEnabled(serverUrl: string | null, isAdmin: boolean): boolean {
  if (!serverUrl) return false;
  return on(`${UPLOAD_KEY}:${serverUrl}`, isAdmin);
}

export function setAutoUpload(serverUrl: string, isAdmin: boolean, value: boolean): void {
  set(`${UPLOAD_KEY}:${serverUrl}`, value, isAdmin);
}

// ── The clip behind Now Playing ─────────────────────────────────────────────

const CANVAS_KEY = 'attackfm-now-playing-video';

/**
 * Whether the full player fetches each song's looping video clip.
 *
 * On by default: it is a real part of that screen. But it is megabytes per
 * song, downloaded whole because a <video> cannot stream through the Cache
 * API, and on a Spotify-configured server the lookup goes out to Spotify by
 * song title - so one switch covers both the data and that lookup. Off leaves
 * the blurred cover that already stands in for songs without a clip, so there
 * is no second code path to keep working.
 */
export function nowPlayingVideoEnabled(): boolean {
  return on(CANVAS_KEY, true);
}

export function setNowPlayingVideo(value: boolean): void {
  set(CANVAS_KEY, value, true);
}
