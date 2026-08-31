import { osNoticesEnabled } from '../settings/behaviourPrefs.ts';
import type { Notice } from './notices.ts';

/**
 * The bell, on the phone.
 *
 * Everything the app has to say already funnels through `noteNotice`, and until
 * now it all stopped at a bell in the app's own chrome - which means the news
 * reached you only in the one situation where you did not need telling, because
 * you were looking at the app. This puts the same row in the OS tray.
 *
 * LOCAL notifications, not push. The distinction matters and is easy to blur:
 * this is the app, running on your phone, raising an alert on the device it is
 * already on. It needs no APNs key, no Firebase project and no device token,
 * and it covers every kind of news the app RAISES ITSELF - a download landing,
 * stems finishing, the AI passes - because those are watched by this device's
 * own pollers and cannot happen while the app is not running anyway. What it
 * cannot do is wake a phone for something the SERVER decided while the app was
 * closed (the digest, the weekly recap); that is `push.rs`, and it is still
 * waiting on keys.
 *
 * Best-effort throughout. Every failure path here ends in the notice still
 * being in the bell where it always was, because a tray that refuses is not a
 * reason to lose the news.
 */

/** The plugin, imported lazily so a desktop build that never notifies does not
 *  carry it, and so an older binary without the plugin fails at the call
 *  rather than at module load. */
type Plugin = typeof import('@tauri-apps/plugin-notification');
let plugin: Promise<Plugin | null> | null = null;

function load(): Promise<Plugin | null> {
  plugin ??= import('@tauri-apps/plugin-notification').catch(() => null);
  return plugin;
}

/**
 * Whether this build can notify at all.
 *
 * The plugin is a NATIVE one: the JS half imports fine anywhere, and then every
 * call fails on a binary that was built before the plugin was added. Since the
 * frontend ships over the air and the binary does not, that pairing is not
 * hypothetical - it is what every already-installed copy looks like the day
 * this ships. So capability is decided by a real call, once, and remembered.
 */
let granted: boolean | null = null;
let asking: Promise<boolean> | null = null;

/**
 * Ask, at most once per run, and only when there is something to show.
 *
 * Deliberately NOT asked at launch. A permission prompt in the first seconds of
 * an app, before it has done anything, is the one most people refuse - and on
 * Android a refusal is close to permanent. Asked instead at the first moment
 * the app actually has something to tell you, where the prompt has an obvious
 * answer.
 */
export async function ensureOsNotifyPermission(): Promise<boolean> {
  if (granted !== null) return granted;
  asking ??= (async () => {
    const api = await load();
    if (!api) return false;
    try {
      let ok = await api.isPermissionGranted();
      if (!ok) ok = (await api.requestPermission()) === 'granted';
      granted = ok;
      return ok;
    } catch {
      // No plugin in this binary (an OTA running on an older shell), or a
      // platform with no tray. Remembered as a no, so the next hundred notices
      // do not each pay for the same failing round trip.
      granted = false;
      return false;
    }
  })();
  return asking;
}

/** What the settings row shows without provoking a prompt: null when we have
 *  not yet had cause to ask. */
export function osNotifyState(): boolean | null {
  return granted;
}

/**
 * Are you already looking at this?
 *
 * A tray alert for something the screen in front of you just announced is
 * noise, so a notice raised while the app is in the foreground stays in the
 * bell alone.
 *
 * `hasFocus` rather than `visibilityState`, and that is not interchangeable
 * here: this app deliberately keeps its webview RESUMED in the background so
 * music keeps playing (the foreground service does the same job on Android),
 * which is exactly the state where a visibility check still says "visible" and
 * would swallow every notification the feature exists for. Window focus is the
 * thing the OS actually takes away when you leave.
 */
function inTheForeground(): boolean {
  try {
    return document.visibilityState === 'visible' && document.hasFocus();
  } catch {
    return false;
  }
}

/** A stable 31-bit number for a string id, so a re-reported job REPLACES its
 *  own tray entry instead of stacking a second one beside it. */
function idNumber(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h | 0);
}

/**
 * Put a notice in the tray, if it belongs there.
 *
 * Called for rows that are genuinely NEW - a restated story (the same job seen
 * again by the next poll) has already been shown and must not buzz twice.
 */
export function mirrorNoticeToOs(notice: Notice): void {
  if (!osNoticesEnabled()) return;
  if (inTheForeground()) return;
  void (async () => {
    if (!(await ensureOsNotifyPermission())) return;
    const api = await load();
    if (!api) return;
    try {
      api.sendNotification({
        id: idNumber(notice.id),
        title: notice.title,
        body: notice.body,
        // Groups the app's news together in the shade rather than letting a
        // busy import scatter twenty separate entries down it.
        group: 'attackfm',
        // The song this entry is about, when it is about one - the tap
        // handler (notifyTap.tsx) reads it back and starts the song.
        ...(notice.song ? { extra: { songTitle: notice.song.title, songArtist: notice.song.artist } } : {}),
      });
    } catch {
      // The tray refused. The row is in the bell regardless.
    }
  })();
}

/**
 * One notification, on purpose, right now.
 *
 * The settings row's "Send a test one", and the only path here that ignores
 * both the foreground check and the "is it new" rule - because somebody who
 * just pressed a button asking to SEE a notification is, by definition, looking
 * at the app, and suppressing it would answer their question with silence. It
 * still goes through the same permission gate and the same plugin call, so a
 * test that arrives means the real ones will too.
 */
export async function sendTestNotification(): Promise<'sent' | 'refused' | 'unsupported'> {
  const api = await load();
  if (!api) return 'unsupported';
  if (!(await ensureOsNotifyPermission())) return 'refused';
  try {
    api.sendNotification({
      id: idNumber('attackfm-test'),
      title: 'AttackFM',
      body: "That's what a notification will look like.",
      group: 'attackfm',
    });
    return 'sent';
  } catch {
    return 'unsupported';
  }
}
