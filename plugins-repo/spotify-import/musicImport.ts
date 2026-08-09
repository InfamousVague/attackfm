// The job shape is the host's contract now (importsBridge), because core
// surfaces consume the same queue this plugin provides. Re-exported so the
// plugin's own files keep importing from here.
import type { MusicImportJob, MusicImportState } from '@attackfm/app/importsBridge';
export type { MusicImportJob, MusicImportState };

const MAGNET_RE = /^magnet:/i;

/**
 * Whether a pasted string is a music-service link AttackFM can import. Ported
 * from ghostwire: Spotify (URI + web), Apple Music, Tidal, Deezer, YT Music,
 * Qobuz. Magnets are explicitly excluded.
 */
export function isMusicImportLink(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v || MAGNET_RE.test(v)) return false;
  return (
    v.startsWith('spotify:') ||
    /\bopen\.spotify\.com\//.test(v) ||
    /\bmusic\.apple\.com\//.test(v) ||
    /\b(?:listen\.)?tidal\.com\//.test(v) ||
    /\bdeezer\.com\//.test(v) ||
    /\bmusic\.youtube\.com\//.test(v) ||
    /\b(?:open|play)\.qobuz\.com\//.test(v)
  );
}

// --- Server transport --------------------------------------------------------
//
// The same queue, run on the hub. Signed into a server, imports download where
// the music lives (SpotiFLAC on the box) and index straight into the catalog,
// so a phone - which can never spawn the engine locally - imports exactly like
// the desktop. The wire shape is the same MusicImportJob, so the queue UI does
// not know which transport it is watching.

import type { ServerSession } from '../../src/app/server.ts';

export async function serverRequest<T>(
  session: ServerSession,
  path: string,
  init: RequestInit = {},
): Promise<T> {
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

export async function serverEnqueueImport(session: ServerSession, url: string): Promise<MusicImportJob> {
  return serverRequest<MusicImportJob>(session, '/api/imports', {
    method: 'POST',
    body: JSON.stringify({ url }),
  });
}

export async function serverListImports(session: ServerSession): Promise<MusicImportJob[]> {
  const reply = await serverRequest<{ jobs: MusicImportJob[] }>(session, '/api/imports');
  return reply.jobs;
}

export async function serverRemoveImport(session: ServerSession, id: string): Promise<void> {
  await serverRequest(session, `/api/imports/${id}`, { method: 'DELETE' });
}

export async function serverRetryImport(session: ServerSession, id: string): Promise<void> {
  await serverRequest(session, `/api/imports/${id}/retry`, { method: 'POST' });
}

export async function serverCancelImport(session: ServerSession, id: string): Promise<void> {
  await serverRequest(session, `/api/imports/${id}/cancel`, { method: 'POST' });
}

export async function serverClearImports(session: ServerSession, states: MusicImportState[]): Promise<void> {
  await serverRequest(session, '/api/imports/clear', {
    method: 'POST',
    body: JSON.stringify({ states }),
  });
}
