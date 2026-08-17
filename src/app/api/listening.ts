import { request, type ServerSession } from './http.ts';

// --- listening state ------------------------------------------------------

/**
 * The Spotify Canvas clip for a track, or null when there is none (or the
 * server has no Spotify session configured). Best-effort and quiet: any failure
 * resolves to null so the now-playing screen just keeps its blurred cover.
 */
export async function fetchCanvas(
  session: ServerSession,
  title: string,
  artist: string,
  signal?: AbortSignal,
  trackId?: number | null,
): Promise<string | null> {
  try {
    const params: Record<string, string> = { title, artist };
    // Telling the server which track this is lets it keep the clip beside the
    // song, so every later play is served from your own library rather than
    // asking Spotify again.
    if (typeof trackId === 'number') params.trackId = String(trackId);
    const reply = await request<{ url: string | null }>(
      session.url,
      `/api/canvas?${new URLSearchParams(params).toString()}`,
      { token: session.token, signal },
    );
    const url = reply.url ?? null;
    if (!url) return null;
    // A stored clip comes back as a path on this server. It needs the stream
    // token in the query, because a <video src> cannot send a header.
    if (url.startsWith('/')) {
      return `${session.url}${url}?t=${encodeURIComponent(session.streamToken)}`;
    }
    return url;
  } catch {
    return null;
  }
}

/** Tells the server where the listener got to, so another device can resume. */
export async function reportPosition(
  session: ServerSession,
  trackId: number,
  positionMs: number,
): Promise<void> {
  await request(session.url, '/api/play-state', {
    method: 'POST',
    body: JSON.stringify({ trackId, positionMs: Math.round(positionMs) }),
    token: session.token,
  });
}

/** Every resume position this account has, newest first - the audiobook
 *  shelf's "continue where you left off". */
export interface PlayState {
  trackId: number;
  positionMs: number;
  updatedAt: number;
}

export async function fetchPlayStates(session: ServerSession): Promise<PlayState[]> {
  const reply = await request<{ states: PlayState[] }>(session.url, '/api/play-state', {
    token: session.token,
  });
  return reply.states;
}

/**
 * Logs one qualifying play. Fire-and-forget from the player: a listen that
 * fails to record is not worth interrupting.
 */
export function reportPlay(session: ServerSession, trackId: number): void {
  void request(session.url, '/api/plays', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ trackId }),
  }).catch(() => {});
}
