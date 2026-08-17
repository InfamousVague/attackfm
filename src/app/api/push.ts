import { request, type ServerSession } from './http.ts';

/**
 * Notifications, and what a listener wants to be told.
 *
 * The kinds are the server's (`push.rs`), and this side never invents one: the
 * prefs reply materialises every kind with where the account stands on it, so
 * a kind added on the server shows up here without a release.
 */
export interface PushPrefs {
  /** kind -> wanted. Unset on the server means on, resolved before it ships. */
  prefs: Record<string, boolean>;
  /** How many devices are registered to receive them. Zero means nothing can
   *  arrive however the switches are set - which is the state worth showing. */
  devices: number;
}

export async function fetchPushPrefs(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<PushPrefs> {
  return request<PushPrefs>(session.url, '/api/push/prefs', { token: session.token, signal });
}

/** One kind, switched. */
export async function setPushPref(
  session: ServerSession,
  kind: string,
  enabled: boolean,
): Promise<void> {
  await request(session.url, '/api/push/prefs', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ kind, enabled }),
  });
}

/** This device asking to be told things. The token comes from the platform,
 *  not from us - see notifications.ts. */
export async function registerPushDevice(
  session: ServerSession,
  token: string,
  platform: string,
  label: string,
): Promise<void> {
  await request(session.url, '/api/push/register', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ token, platform, label }),
  });
}

/** The reverse, on sign-out. */
export async function unregisterPushDevice(
  session: ServerSession,
  token: string,
): Promise<void> {
  await request(session.url, '/api/push/unregister', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ token }),
  });
}
