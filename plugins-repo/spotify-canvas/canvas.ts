/**
 * The Canvas bridge - what this plugin needs from the hub.
 *
 * Two of these three endpoints live under `/api/ai`, which reads oddly for a
 * Spotify cookie. That prefix is a misnomer rather than a mistake: it is the
 * server's general OWNER-SETTINGS store (`ai::setting`, resolving an override
 * in `server_prefs` before the environment), and the cookie was deliberately
 * put there because that store is the thing that survives a redeploy. Renaming
 * the route would break every published plugin built against it, so the name
 * stays and this comment carries the explanation.
 *
 * Everything here is admin-gated on the SERVER. The pane hides itself for a
 * listener as a courtesy; the refusal is the server's.
 */

import type { ServerSession } from '../../src/app/server.ts';

/** What the owner may set from here. `null` clears an override. */
export interface CanvasSettingsPatch {
  /** The owner's Spotify session cookie. Write-only - see below. */
  spotifyCookie?: string | null;
  /** Whether a song with no Canvas gets one of the shipped stand-in loops. */
  canvasStock?: boolean | null;
}

export interface CanvasSettings {
  /**
   * Whether a cookie is configured - never the cookie. It is a live login to
   * the owner's Spotify account, so the server has no read path for it at all:
   * this plugin is told yes or no and nothing else, and replacing one means
   * pasting a new one.
   */
  spotifyCookieSet: boolean;
  canvasStock: boolean;
}

async function hub<T>(session: ServerSession, path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${session.url}${path}`, { ...init, headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** The whole owner report, of which only two fields concern this plugin. */
export async function fetchCanvasSettings(session: ServerSession): Promise<CanvasSettings> {
  const report = await hub<{ settings?: Partial<CanvasSettings> }>(session, '/api/ai');
  return {
    spotifyCookieSet: report.settings?.spotifyCookieSet === true,
    canvasStock: report.settings?.canvasStock === true,
  };
}

export async function saveCanvasSettings(
  session: ServerSession,
  patch: CanvasSettingsPatch,
): Promise<CanvasSettings> {
  const next = await hub<Partial<CanvasSettings>>(session, '/api/ai/settings', {
    method: 'POST',
    body: JSON.stringify(patch),
  });
  return {
    spotifyCookieSet: next.spotifyCookieSet === true,
    canvasStock: next.canvasStock === true,
  };
}

/**
 * Forget every "this song has none" answer and start looking again.
 *
 * The clips already kept are untouched; only the noes are dropped, which are
 * the only part worth re-asking after a cookie changes or a library moves.
 */
export async function resweepCanvases(session: ServerSession): Promise<{ forgotten: number }> {
  return hub<{ forgotten: number }>(session, '/api/canvas/resweep', { method: 'POST' });
}
