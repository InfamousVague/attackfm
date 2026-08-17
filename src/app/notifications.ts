import { isTauri } from './tauri.ts';
import { registerPushDevice, type ServerSession } from './server.ts';

/**
 * The device's end of push: getting a token from the platform, and telling the
 * server where to send.
 *
 * The server side of this is finished - kinds, preferences, triggers, the
 * hourly sweeps - and it has been waiting on exactly one thing: a token. A
 * token is not something a web view can produce. It comes from the OS, in
 * answer to a native registration call, and on iOS that call only succeeds
 * when the app id carries the Push Notifications capability and the build is
 * signed with a matching profile. Neither is a thing this layer can arrange.
 *
 * So this module is the seam. `pushDeviceToken` asks the native side and gets
 * null today, on every platform; `syncPushRegistration` does the whole dance
 * anyway and quietly does nothing without one. When the native half lands, it
 * answers the same command and everything above here starts working with no
 * further change - which is the same bargain push.rs made on the server, where
 * a missing Apple key makes the pipeline inert rather than broken.
 */

/** What the last successful registration used, so a sign-out can undo exactly
 *  that and a repeat sign-in does not register twice. */
let registered: string | null = null;

/**
 * This device's push token, or null when it cannot have one.
 *
 * Null is the ordinary answer, not a failure: on the web there is no such
 * thing, and on iOS the native command does not exist yet. Callers treat it as
 * "notifications are not available here" and say so plainly rather than
 * reporting an error nobody can act on.
 */
export async function pushDeviceToken(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const core = await import('@tauri-apps/api/core');
    const token = await core.invoke<string | null>('push_device_token');
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    // The command is absent until the native half exists, and an absent
    // command is the expected state rather than something to shout about.
    return null;
  }
}

/** A label the devices pane can show beside the token. */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return 'iPad';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Android phone';
  return 'This device';
}

function platform(): string {
  return /Android/.test(navigator.userAgent) ? 'android' : 'ios';
}

/**
 * Point this device's notifications at the session that is signed in, or take
 * it off the list when there is none. Safe to call on every session change:
 * it registers a given token once and unregisters only what it registered.
 */
export async function syncPushRegistration(session: ServerSession | null): Promise<void> {
  const token = await pushDeviceToken();
  if (!token) return;

  if (!session) {
    // Nothing to unregister against once the session is gone - the endpoint
    // needs the credentials that just went away - so this only clears the
    // local memory of it. The server retires a token when Apple says it is
    // dead, which is the authority that outlives any sign-out.
    registered = null;
    return;
  }

  if (registered === token) return;
  try {
    await registerPushDevice(session, token, platform(), deviceLabel());
    registered = token;
  } catch {
    // A failed registration must never block a sign-in; the next session
    // change tries again.
    registered = null;
  }
}

