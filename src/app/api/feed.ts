import { request, type ServerSession } from './http.ts';

// --- the home feed -----------------------------------------------------------

/** The home page's shelves, as track ids resolved against the synced library. */
export interface HomeFeed {
  recent: number[];
  heavy: number[];
  /** The same songs with their play counts, most-played first. Absent on
   *  servers older than this field. */
  heavyPlays?: { id: number; plays: number }[];
  fresh: number[];
  /** Recently-played albums, each a full ordered track-id list to play as-is. */
  jumpBackIn: number[][];
  /** The user's top artist names this month. */
  topArtists: string[];
  mixes: { id: string; title: string; blurb: string; trackIds: number[]; flavor: 'ai' | 'heuristic' }[];
  /** Whether a local model is wired up server-side. */
  ai: boolean;
}

export async function fetchHome(session: ServerSession): Promise<HomeFeed> {
  return request<HomeFeed>(session.url, '/api/home', { token: session.token });
}

/** One artist's most-played songs, all-time: ids + counts, most-played first.
 * Ids resolve against the synced library like the home feed's shelves do. */
export async function fetchArtistTop(
  session: ServerSession,
  artist: string,
): Promise<{ id: number; plays: number }[]> {
  const out = await request<{ top: { id: number; plays: number }[] }>(
    session.url,
    `/api/artist-top?name=${encodeURIComponent(artist)}`,
    { token: session.token },
  );
  return out.top ?? [];
}

/**
 * What else belongs on one playlist, ranked against the LIST's own character
 * rather than the listener's. `ai` says whether a model is reading lyrics -
 * without one the ranking is tempo and genre alone, and the surface hides
 * itself rather than promise more than it did.
 */
export async function fetchPlaylistSuggestions(
  session: ServerSession,
  playlistId: string,
  signal?: AbortSignal,
): Promise<{ trackIds: number[]; ai: boolean }> {
  return request<{ trackIds: number[]; ai: boolean }>(
    session.url,
    `/api/playlists/${encodeURIComponent(playlistId)}/suggestions`,
    { token: session.token, signal },
  );
}
