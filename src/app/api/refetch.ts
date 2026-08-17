import { request, type ServerSession } from './http.ts';

/**
 * Re-fetching a track that came down as the wrong recording.
 *
 * The server searches the catalogues with the track's OWN tags - which say
 * what was wanted, even when the audio is a live cut or a cover - downloads
 * several alternates side by side into staging, and holds them there until
 * one is chosen. Nothing in the library changes until `keepCandidate`.
 */
export interface RefetchCandidate {
  index: number;
  source: string;
  title: string;
  artist: string;
  album: string;
  state: 'queued' | 'downloading' | 'ready' | 'failed';
  error: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  lossless: boolean;
  codec: string;
  /** An earlier candidate whose audio this one matches. */
  sameAs: number | null;
}

export interface RefetchJob {
  id: string;
  trackId: number;
  state: 'hunting' | 'ready' | 'done' | 'failed';
  error: string | null;
  current: {
    id: number;
    title: string;
    artist: string;
    album: string;
    durationMs: number | null;
    lossless: boolean;
    codec: string;
  };
  candidates: RefetchCandidate[];
}

export async function startRefetch(
  session: ServerSession,
  trackId: number,
): Promise<RefetchJob> {
  return request<RefetchJob>(session.url, `/api/refetch/track/${trackId}`, {
    method: 'POST',
    token: session.token,
  });
}

export async function fetchRefetch(
  session: ServerSession,
  id: string,
  signal?: AbortSignal,
): Promise<RefetchJob> {
  return request<RefetchJob>(session.url, `/api/refetch/${encodeURIComponent(id)}`, {
    token: session.token,
    signal,
  });
}

/** The staged audio for one candidate, for the preview player. Range-capable,
 *  so the modal's scrubber works - skipping to the middle is how a live take
 *  gives itself away. */
export function refetchAudioUrl(session: ServerSession, id: string, index: number): string {
  return `${session.url}/api/refetch/${encodeURIComponent(id)}/audio/${index}?t=${encodeURIComponent(session.streamToken)}`;
}

/** This one is the song: file it, move the old track's history onto it, and
 *  scrap the rest. */
export async function keepCandidate(
  session: ServerSession,
  id: string,
  index: number,
): Promise<{ trackId: number; replaced: number }> {
  return request(session.url, `/api/refetch/${encodeURIComponent(id)}/keep`, {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ index }),
  });
}

/** None of them were right. Everything staged goes; the library is untouched. */
export async function scrapRefetch(session: ServerSession, id: string): Promise<void> {
  await request(session.url, `/api/refetch/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    token: session.token,
  });
}
