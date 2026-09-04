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
 * Two scopes. `'hub'` is the public sample, drawn from every member's music
 * including auditions nobody has adopted. `'mine'` (`/api/wall/mine`, token
 * authed) is the same shape drawn only from what THIS listener can see - the
 * library plus their own pulls - which is the honest wall for a page that is
 * about them. A hub too old to have the route answers 404, and the caller gets
 * the public sample instead of nothing: the hero would rather wear the
 * household's sleeves than a flat panel.
 *
 * Held per server and scope for the session. The signature is good for the
 * day and the sample only changes what it draws, so re-asking on every mount
 * would buy a reshuffle nobody asked for and cost a request each time.
 */
export type WallScope = 'hub' | 'mine';

const cache = new Map<string, string[]>();
const inFlight = new Map<string, Promise<string[]>>();

function absolutise(url: string, list: unknown): string[] {
  return (Array.isArray(list) ? list : [])
    .filter((p): p is string => typeof p === 'string')
    .map((p) => (p.startsWith('/') ? `${url}${p}` : p));
}

async function loadPublic(url: string): Promise<string[]> {
  // No token on purpose: the route is public and the URLs it returns carry
  // their own signature. Failure is silent - a header with no wall is the
  // header this page wore before there was one.
  const res = await fetch(`${url}/api/wall`);
  if (!res.ok) return [];
  const body = (await res.json()) as { canvases?: unknown };
  return absolutise(url, body.canvases);
}

async function loadMine(session: ServerSession): Promise<string[]> {
  const res = await fetch(`${session.url}/api/wall/mine`, {
    headers: { authorization: `Bearer ${session.token}` },
  });
  // Not built yet on this hub: the public sample is the next best wall.
  if (res.status === 404) return loadPublic(session.url);
  if (!res.ok) return [];
  const body = (await res.json()) as { canvases?: unknown };
  return absolutise(session.url, body.canvases);
}

export function useWallClips(session: ServerSession | null, scope: WallScope = 'hub'): string[] {
  return useWallClipsState(session, scope).clips;
}

/**
 * The clips, and whether the server has ANSWERED - an empty list before the
 * answer and an empty list after it are different facts to a caller that
 * falls back to something else (the Discover hero asks for a single Canvas
 * clip only once it knows there is no wall to be had).
 */
export function useWallClipsState(
  session: ServerSession | null,
  scope: WallScope = 'hub',
): { clips: string[]; settled: boolean } {
  const url = session?.url ?? null;
  const key = url ? `${scope}|${url}` : null;
  const [clips, setClips] = useState<string[]>(() => (key ? (cache.get(key) ?? []) : []));
  const [settled, setSettled] = useState<boolean>(() => (key ? cache.has(key) : false));

  useEffect(() => {
    if (!key || !session) {
      setClips([]);
      setSettled(false);
      return;
    }
    const have = cache.get(key);
    if (have) {
      setClips(have);
      setSettled(true);
      return;
    }
    setSettled(false);
    let live = true;
    // One flight per server and scope even if two headers mount at once.
    let run = inFlight.get(key);
    if (!run) {
      run = (scope === 'mine' ? loadMine(session) : loadPublic(session.url)).catch(() => []);
      inFlight.set(key, run);
      void run.then((got) => {
        cache.set(key, got);
        inFlight.delete(key);
      });
    }
    void run.then((got) => {
      if (!live) return;
      setClips(got);
      setSettled(true);
    });
    return () => {
      live = false;
    };
    // The session's token can rotate without the URL changing; the wall is
    // keyed on the URL and scope, which is what the cache is keyed on too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { clips, settled };
}
