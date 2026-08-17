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

export async function request<T>(
  url: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');

  const response = await fetch(`${url}${path}`, { ...rest, headers });
  if (!response.ok) {
    // The server answers errors as plain text, which is what belongs in a
    // toast; a body that will not read is not worth failing twice over.
    const detail = await response.text().catch(() => '');
    throw new ServerError(response.status, detail || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}
