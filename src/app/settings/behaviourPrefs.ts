import { onMeteredConnection } from '../core/network.ts';

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

/**
 * Verbose notifications: tell me when the machinery does something.
 *
 * Off by default. On, the bell also rings for the things that normally happen
 * silently in the background - a download STARTING (landing already rings), a
 * song being pulled into stems by the server's prefetcher, the AI passes
 * (fast profiles, refinement, curation, discovery, the home and station
 * builders) starting and finishing. Device-local: this is about how much one
 * phone interrupts you, not a fact about the account.
 *
 * Read at EMIT time by the watchers (DownloadNotices, VerboseNotices) rather
 * than held in state, so flipping the switch takes effect on the next event
 * without anything remounting.
 */
const VERBOSE_KEY = 'attackfm-notify-verbose';

export function verboseNoticesEnabled(): boolean {
  return on(VERBOSE_KEY, false);
}

export function setVerboseNotices(value: boolean): void {
  set(VERBOSE_KEY, value, false);
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

// ── Filling the phone's cache ───────────────────────────────────────────────

const WIFI_ONLY_KEY = 'attackfm-wifi-only';

/**
 * Whether automatic downloads wait for a connection nobody is billed for.
 *
 * ON by default, which changes the shipped behaviour rather than preserving
 * it - the one place in this file that does. The justification is that the app
 * already agreed: the storage pane carried the line "there is no wi-fi-only
 * switch yet, so this can use mobile data", which is a feature apologising for
 * its own default. Something that fills a 15 GB cache in the background should
 * not have been spending mobile data unasked in the first place, and the
 * people most affected by that are the least likely to go looking for a switch
 * to stop it.
 *
 * Turning it on costs less than it looks like it should, because of what it
 * does NOT cover. Playing music is untouched - streaming a song you asked for
 * is not a download. Pinning is untouched: `Keep on this device` is you
 * asking, out loud, usually because you are about to lose signal, and that is
 * the worst imaginable moment to be refused. `Check now` is untouched for the
 * same reason - a button press is a request. What is left is exactly the part
 * that runs on its own six-hourly schedule while you are looking at something
 * else, which is the part that should have been asking permission.
 *
 * And it only ever holds where the device can actually TELL. See network.ts:
 * an unknown connection downloads, so this never silently disables the cache
 * on a platform that cannot answer the question.
 */
export function wifiOnlyDownloads(): boolean {
  return on(WIFI_ONLY_KEY, true);
}

export function setWifiOnlyDownloads(value: boolean): void {
  set(WIFI_ONLY_KEY, value, true);
}

/**
 * Whether something may pull bytes down right now, on its own initiative.
 *
 * The one place the switch and the connection are combined, because the switch
 * shipped guarding only the cache sweep and that was not the whole promise.
 * The copy under it says "automatic downloads wait for Wi-Fi", and every
 * unguarded fetch elsewhere in the app makes that sentence false - which is
 * worse than having no switch, because somebody read it and believed it. Two
 * were found within an hour of shipping: the Stems room's per-part measuring,
 * and the Now Playing video clip.
 *
 * So it lives here, once, and anything that downloads without being asked
 * awaits it. ASK AT THE MOMENT OF THE FETCH, not when the screen opens: the
 * answer changes as somebody walks out of the house, and a value read at mount
 * is a stale promise by the third song.
 *
 * Not for anything a person just asked for out loud. See the header on
 * `sweepIfIdle` for where that line falls and why it is drawn there.
 */
export async function autoDownloadAllowed(): Promise<boolean> {
  if (!wifiOnlyDownloads()) return true;
  return !(await onMeteredConnection());
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

/**
 * Shake and flick on the Now Playing screen.
 *
 * OFF by default, unlike everything else here, and the reason is the failure
 * mode rather than the feature. A switch that costs battery can be left on by
 * someone who never notices; a gesture that misfires skips the song they were
 * listening to, and they will not connect it to a setting they never turned on.
 * So this one is asked for.
 *
 * The tilt that moves the artwork a few pixels is NOT behind this. It cannot
 * misfire - the worst it can do is move something slightly - and it already
 * stops for anyone who has asked their system to stop animations.
 */
export function motionGesturesEnabled(): boolean {
  return on('attackfm-motion-gestures', false);
}

export function setMotionGestures(value: boolean): void {
  set('attackfm-motion-gestures', value, false);
}
