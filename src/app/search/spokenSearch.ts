import { request } from '../api/http.ts';
import { originFromPath, trackIdFromPath } from '../server.ts';
import { sessionForOrigin, readSessions } from '../servers/sessions.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Searching the library by what it SAYS.
 *
 * The one search the client cannot answer itself. Every other lane runs
 * against the in-memory index, which is faster than any round trip - but the
 * words inside the audio are megabytes per book and live only on the hub, so
 * this lane asks the hub and the hub answers with MOMENTS: which track, and
 * when the line was said.
 */

export interface SpokenHit {
  trackId: number;
  startMs: number;
  text: string;
  title: string;
  artist: string;
  kind: string;
  /** Resolved against the local library, so the row can play it. */
  track: Track | null;
}

interface Reply {
  hits: Omit<SpokenHit, 'track'>[];
}

/**
 * Ask every signed-in server, because a phrase belongs to whichever library
 * holds it and the listener does not think in servers. A hub too old to know
 * the route simply answers nothing.
 */
export async function searchSpoken(
  query: string,
  tracks: readonly Track[],
  signal?: AbortSignal,
): Promise<SpokenHit[]> {
  const q = query.trim();
  if (q.length < 3) return [];
  const { byUrl } = readSessions();
  const sessions = Object.values(byUrl);
  const found = await Promise.all(
    sessions.map(async (session) => {
      try {
        const r = await request<Reply>(
          session.url,
          `/api/words?q=${encodeURIComponent(q)}&n=40`,
          { token: session.token, signal },
        );
        return (r.hits ?? []).map((h) => ({
          ...h,
          // The row needs a real Track to play, and only the local index has
          // one: match by id AND by which server the path names.
          track:
            tracks.find(
              (t) =>
                trackIdFromPath(t.path) === h.trackId &&
                (sessionForOrigin(originFromPath(t.path))?.url ?? '') === session.url,
            ) ?? null,
        }));
      } catch {
        return [];
      }
    }),
  );
  return found.flat().filter((h) => h.track !== null);
}
