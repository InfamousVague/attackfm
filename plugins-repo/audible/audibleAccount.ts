/**
 * The wire calls for the Audible connection, audiobooks-plugin style:
 * session.url + bearer token, a 404 becoming a quiet "your server is too old"
 * rather than a red error. Types mirror the server contract in audible.rs.
 */
import type { ServerSession } from '../../src/app/server.ts';

export class MissingEndpointError extends Error {
  constructor(path: string) {
    super(`endpoint missing: ${path}`);
    this.name = 'MissingEndpointError';
  }
}

async function serverRequest<T>(
  session: ServerSession,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${session.token}`);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${session.url}${path}`, { ...init, headers });
  if (response.status === 404) throw new MissingEndpointError(path);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as T;
}

/** What the server can tell us before a single book is touched. */
export interface AudibleStatus {
  /** Whether the download tools (audible-cli) are installed on the hub at all. */
  toolsInstalled: boolean;
  /** Whether an account's device tokens are stored. */
  connected: boolean;
  /** Who, if the account said. */
  name: string | null;
}

/** The parked login: a URL to sign in at, and the token that ties the paste
 *  back to the server's waiting child. */
export interface LoginStart {
  loginUrl: string;
  token: string;
  locale: string;
}

export async function audibleStatus(session: ServerSession): Promise<AudibleStatus> {
  return serverRequest<AudibleStatus>(session, '/api/audible/status');
}

export async function audibleLoginStart(
  session: ServerSession,
  locale: string,
): Promise<LoginStart> {
  return serverRequest<LoginStart>(session, '/api/audible/login/start', {
    method: 'POST',
    body: JSON.stringify({ locale }),
  });
}

export async function audibleLoginComplete(
  session: ServerSession,
  token: string,
  responseUrl: string,
  locale: string,
): Promise<{ connected: boolean; name: string | null }> {
  return serverRequest(session, '/api/audible/login/complete', {
    method: 'POST',
    body: JSON.stringify({ token, responseUrl, locale }),
  });
}

export async function audibleLogout(session: ServerSession): Promise<{ connected: boolean }> {
  return serverRequest(session, '/api/audible/logout', { method: 'POST' });
}

/** One book you own, as the library endpoint lists it. */
export interface AudibleBook {
  asin: string;
  title: string;
  author: string;
  cover: string | null;
  runtimeMin: number | null;
  percentComplete: number | null;
  /** True once it is already downloaded into the library. */
  ownedLocally: boolean;
}

/** One Audible download, as the queue reports it. */
export interface AudibleJob {
  id: string;
  asin: string;
  title: string;
  author: string;
  cover: string | null;
  state: 'queued' | 'downloading' | 'decrypting' | 'filing' | 'done' | 'error';
  error: string | null;
  createdAt: number;
  trackId: number | null;
}

export async function audibleLibrary(
  session: ServerSession,
): Promise<{ connected: boolean; books: AudibleBook[] }> {
  return serverRequest(session, '/api/audible/library');
}

export async function audibleImport(
  session: ServerSession,
  book: { asin: string; title: string; author: string; cover?: string | null },
): Promise<AudibleJob> {
  const reply = await serverRequest<{ job: AudibleJob }>(session, '/api/audible/import', {
    method: 'POST',
    body: JSON.stringify({ asin: book.asin, title: book.title, author: book.author, cover: book.cover ?? undefined }),
  });
  return reply.job;
}

export async function audibleJobs(session: ServerSession): Promise<AudibleJob[]> {
  const reply = await serverRequest<{ jobs: AudibleJob[] }>(session, '/api/audible/jobs');
  return reply.jobs;
}
