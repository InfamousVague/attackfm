import { useEffect, useState } from 'react';
import type { ServerSession } from '../server.ts';

/**
 * The Canvas clips this server keeps, for the wall behind a header.
 *
 * `/api/wall` is the server's own public glance at itself - a handful of covers
 * and clips under URLs it signed for the day. It was built for the invite
 * landing page, which has no sign-in; that is exactly why it suits a wall.
 * The clips are sampled from the sidecars stored beside the music, so this is
 * "the Canvases throughout your library" rather than a fetch of anything new:
 * no Spotify lookup, no per-track round trip, one ask for the set.
 *
 * Held per server for the session. The signature is good for the day and the
 * sample only changes what it draws, so re-asking on every mount of the Library
 * would buy a reshuffle nobody asked for and cost a request each time.
 */
const cache = new Map<string, string[]>();
const inFlight = new Map<string, Promise<string[]>>();

async function load(url: string): Promise<string[]> {
  // No token on purpose: the route is public and the URLs it returns carry
  // their own signature. Failure is silent - a header with no wall is the
  // header this page wore before there was one.
  const res = await fetch(`${url}/api/wall`);
  if (!res.ok) return [];
  const body = (await res.json()) as { canvases?: unknown };
  const list = Array.isArray(body.canvases) ? body.canvases : [];
  return list
    .filter((p): p is string => typeof p === 'string')
    .map((p) => (p.startsWith('/') ? `${url}${p}` : p));
}

export function useWallClips(session: ServerSession | null): string[] {
  const url = session?.url ?? null;
  const [clips, setClips] = useState<string[]>(() => (url ? (cache.get(url) ?? []) : []));

  useEffect(() => {
    if (!url) {
      setClips([]);
      return;
    }
    const have = cache.get(url);
    if (have) {
      setClips(have);
      return;
    }
    let live = true;
    // One flight per server even if two headers mount at once.
    let run = inFlight.get(url);
    if (!run) {
      run = load(url).catch(() => []);
      inFlight.set(url, run);
      void run.then((got) => {
        cache.set(url, got);
        inFlight.delete(url);
      });
    }
    void run.then((got) => {
      if (live) setClips(got);
    });
    return () => {
      live = false;
    };
  }, [url]);

  return clips;
}
