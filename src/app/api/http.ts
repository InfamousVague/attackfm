import { describeFailure, recordDiag, redactUrl } from '../diag/diagLog.ts';
import { noteServerAnswered, noteServerSilent } from './reachability.ts';

/** A signed-in connection. Everything the app needs to talk to one server. */
export interface ServerSession {
  /** Origin with no trailing slash, e.g. `https://music.example.com`. */
  url: string;
  token: string;
  streamToken: string;
  username: string;
  isAdmin: boolean;
}

/** What a server says about itself before anyone has signed in. */
export interface ServerInfo {
  name: string;
  version: string;
  api: number;
  /** True when no account exists yet - the first visitor makes the admin. */
  needsSetup: boolean;
  /** Whether the box has an ffmpeg, and so whether to offer a quality choice. */
  transcode: boolean;
  tracks: number;
  /** Whose box it is, as the hub names them. Absent from older hubs. */
  owner?: string;
  /** The glance an invite shows: counts only. Absent from older hubs. */
  artists?: number;
  albums?: number;
  playlists?: number;
  members?: number;
}

/** Trims a user-typed address into an origin the fetches can be built on. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  // A bare host is the common way to type this; assume TLS, since anything
  // reachable from a phone should have it.
  if (!/^https?:\/\//i.test(trimmed)) return `https://${trimmed}`;
  return trimmed;
}

export class ServerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A short, honest name for this device: platform, nothing identifying. */
export function deviceLabel(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android';
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad|Macintosh.*Mobile/i.test(ua)) return 'iPad';
  if (/Mac OS X/i.test(ua)) return 'macOS';
  if (/Windows/i.test(ua)) return 'Windows';
  if (/Linux/i.test(ua)) return 'Linux';
  return 'web';
}

export async function request<T>(
  url: string,
  path: string,
  init: RequestInit & { token?: string; timeoutMs?: number } = {},
): Promise<T> {
  const { token, timeoutMs = 30_000, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  // What this device is, for the session it may be asking for - so a hub can
  // list "iPhone" and "macOS" as two sessions and let you end one of them.
  if (!headers.has('x-afm-device')) headers.set('x-afm-device', deviceLabel());
  if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  // Every request gets a deadline. A phone hopping networks mid-flight can
  // black-hole an established connection: the fetch never settles, and every
  // await upstream of it becomes a zombie - the exact "app never loads while
  // the dot is green" wedge. Thirty seconds is long enough for the largest
  // first-sync payload on a slow link and short enough that the caller's
  // error path (retry heartbeats, error strips) actually gets to run. A few
  // explicitly long-running endpoints (such as local AI analysis) opt into a
  // larger deadline without weakening this default for ordinary requests.
  // Hand-rolled rather than AbortSignal.any/timeout, which older WebKit lacks.
  const control = new AbortController();
  const deadline = window.setTimeout(() => control.abort(new Error('request timed out')), timeoutMs);
  if (rest.signal) {
    const outer = rest.signal;
    if (outer.aborted) control.abort(outer.reason);
    else outer.addEventListener('abort', () => control.abort(outer.reason), { once: true });
  }

  let response: Response;
  try {
    response = await fetch(`${url}${path}`, { ...rest, headers, signal: control.signal });
  } catch (err) {
    // The transport failed outright - no status, no body. Written down before
    // it is rethrown, because the callers upstream turn this into a quiet
    // "whatever is on screen stays" and the reason would otherwise be lost.
    recordDiag('request', describeFailure(err, `${url}${path}`));
    // Nobody answered the door. Surfaces that would rather have the hub than
    // the copy already on this device need to know when there is no hub to have.
    noteServerSilent();
    throw err;
  } finally {
    window.clearTimeout(deadline);
  }
  // It replied. A 500 or a 404 is still the server TALKING - only silence means
  // it is gone, and treating an error page as an outage would send the app to
  // the vault over a bad request.
  noteServerAnswered();
  if (!response.ok) {
    // The server answers errors as plain text, which is what belongs in a
    // toast; a body that will not read is not worth failing twice over.
    const detail = await response.text().catch(() => '');
    // 401 is ordinary (a token aged out and the app re-auths), so it is not
    // worth a line; anything else is a fault someone may have to explain.
    if (response.status !== 401) {
      recordDiag(
        'request',
        `HTTP ${response.status} → ${redactUrl(`${url}${path}`)}${detail ? ` — ${detail.slice(0, 120)}` : ''}`,
      );
    }
    throw new ServerError(response.status, detail || `${response.status} ${response.statusText}`);
  }
  try {
    return (await response.json()) as T;
  } catch (err) {
    // A 200 whose body is not JSON. On a phone this is almost never a server
    // bug - it is a captive portal or a proxy answering with its own HTML
    // page - and it presents as an unexplained failure everywhere upstream,
    // because the status said success.
    recordDiag('request', `answered ${response.status} but the body was not JSON → ${redactUrl(`${url}${path}`)}`);
    throw err;
  }
}
