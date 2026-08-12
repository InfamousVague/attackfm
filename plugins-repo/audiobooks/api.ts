/**
 * The wire calls, library-tools style: session.url + bearer token, a 404
 * becoming a quiet "update your server" rather than a red error. Types mirror
 * the server contract in audiobooks.rs exactly.
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

/** One book as the catalogue search lists it. */
export interface CatalogBook {
  id: number;
  title: string;
  author: string;
  cover: string;
  sections: number;
  totaltime: string;
}

/** One download, as the queue reports it. */
export interface BookJob {
  id: string;
  bookId: number;
  title: string;
  author: string;
  cover: string;
  state: 'queued' | 'downloading' | 'done' | 'error';
  total: number;
  completed: number;
  currentSection: string | null;
  error: string | null;
  createdAt: number;
  trackIds: number[];
}

export async function searchBooks(session: ServerSession, q: string): Promise<CatalogBook[]> {
  const reply = await serverRequest<{ results: CatalogBook[] }>(
    session,
    `/api/audiobooks/search?q=${encodeURIComponent(q)}`,
  );
  return reply.results;
}

export async function importBook(session: ServerSession, id: number): Promise<BookJob> {
  const reply = await serverRequest<{ job: BookJob }>(session, '/api/audiobooks/import', {
    method: 'POST',
    body: JSON.stringify({ id }),
  });
  return reply.job;
}

export async function bookJobs(session: ServerSession): Promise<BookJob[]> {
  const reply = await serverRequest<{ jobs: BookJob[] }>(session, '/api/audiobooks/jobs');
  return reply.jobs;
}

/** The bookmark ledger: trackId -> {positionMs, updatedAt}. */
export async function bookmarks(
  session: ServerSession,
): Promise<Map<number, { positionMs: number; updatedAt: number }>> {
  const reply = await serverRequest<{
    states: { trackId: number; positionMs: number; updatedAt: number }[];
  }>(session, '/api/play-state');
  return new Map(reply.states.map((s) => [s.trackId, s]));
}
