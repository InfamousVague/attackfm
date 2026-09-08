import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useWallClips, useWallClipsState } from './wallClips.ts';
import type { ServerSession } from '../server.ts';

/**
 * The Canvas clips behind a header.
 *
 * Held per server AND scope for the whole session, so the URL a test uses is
 * the thing that isolates it from its neighbours - the module cache has no
 * reset and deliberately so ("re-asking on every mount would buy a reshuffle
 * nobody asked for"). Each test below gets its own hub.
 */
let n = 0;
const hub = (over: Partial<ServerSession> = {}): ServerSession =>
  ({ url: `https://hub-${(n += 1)}.example`, token: 'tok', username: 'matt', ...over }) as ServerSession;

interface Answer {
  status?: number;
  canvases?: unknown;
}

/** Stubs fetch, answering per path, and records every request made. */
function serve(answers: Record<string, Answer>) {
  const seen: { url: string; auth: string | null }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string, init?: RequestInit) => {
      const url = String(input);
      seen.push({
        url,
        auth: (init?.headers as Record<string, string> | undefined)?.authorization ?? null,
      });
      const match = Object.entries(answers).find(([path]) => url.endsWith(path));
      const answer = match?.[1] ?? { status: 404 };
      return Promise.resolve({
        ok: (answer.status ?? 200) < 400,
        status: answer.status ?? 200,
        json: () => Promise.resolve({ canvases: answer.canvases }),
      } as Response);
    }),
  );
  return seen;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('useWallClips', () => {
  it('makes a server-relative clip path absolute against its own hub', async () => {
    // The wall is drawn from another origin's signed URLs; a bare "/api/..."
    // would resolve against the app instead.
    const s = hub();
    serve({ '/api/wall': { canvases: ['/api/canvas/1.mp4', 'https://cdn.example/2.mp4'] } });
    const { result } = renderHook(() => useWallClips(s));
    await waitFor(() =>
      expect(result.current).toEqual([`${s.url}/api/canvas/1.mp4`, 'https://cdn.example/2.mp4']),
    );
  });

  it('drops anything in the list that is not a string', async () => {
    const s = hub();
    serve({ '/api/wall': { canvases: ['/a.mp4', 42, null, { u: 'x' }] } });
    const { result } = renderHook(() => useWallClips(s));
    await waitFor(() => expect(result.current).toEqual([`${s.url}/a.mp4`]));
  });

  it('is an empty wall - not a crash - when the body is the wrong shape', async () => {
    const s = hub();
    serve({ '/api/wall': { canvases: 'not a list' } });
    const { result, rerender } = renderHook(() => useWallClipsState(s));
    await waitFor(() => expect(result.current.settled).toBe(true));
    rerender();
    expect(result.current.clips).toEqual([]);
  });

  it('asks once for two headers mounted on the same hub and scope', async () => {
    const s = hub();
    const seen = serve({ '/api/wall': { canvases: ['/a.mp4'] } });
    const a = renderHook(() => useWallClips(s));
    const b = renderHook(() => useWallClips(s));
    await waitFor(() => expect(a.result.current).toHaveLength(1));
    await waitFor(() => expect(b.result.current).toHaveLength(1));
    expect(seen).toHaveLength(1);
  });

  it('serves a later mount from the cache without asking again', async () => {
    const s = hub();
    const seen = serve({ '/api/wall': { canvases: ['/a.mp4'] } });
    const first = renderHook(() => useWallClips(s));
    await waitFor(() => expect(first.result.current).toHaveLength(1));
    first.unmount();
    const second = renderHook(() => useWallClipsState(s));
    // Straight out of the cache, on the first render - no answer to wait for.
    expect(second.result.current.settled).toBe(true);
    expect(second.result.current.clips).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });
});

describe('the "mine" scope', () => {
  it('asks the token-authed route, and carries the token', async () => {
    const s = hub();
    const seen = serve({ '/api/wall/mine': { canvases: ['/mine.mp4'] } });
    const { result } = renderHook(() => useWallClips(s, 'mine'));
    await waitFor(() => expect(result.current).toEqual([`${s.url}/mine.mp4`]));
    expect(seen[0]?.url).toBe(`${s.url}/api/wall/mine`);
    expect(seen[0]?.auth).toBe('Bearer tok');
  });

  it('falls back to the public sample on a hub too old to have the route', async () => {
    // "The hero would rather wear the household's sleeves than a flat panel."
    const s = hub();
    serve({
      '/api/wall/mine': { status: 404 },
      '/api/wall': { canvases: ['/public.mp4'] },
    });
    const { result } = renderHook(() => useWallClips(s, 'mine'));
    await waitFor(() => expect(result.current).toEqual([`${s.url}/public.mp4`]));
  });

  it('does NOT fall back on any other failure', async () => {
    // A 500 is a hub that has the route and is unwell; borrowing the public
    // wall there would hide a real fault behind other people's music.
    const s = hub();
    const seen = serve({ '/api/wall/mine': { status: 500 }, '/api/wall': { canvases: ['/p.mp4'] } });
    const { result } = renderHook(() => useWallClipsState(s, 'mine'));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.clips).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('keeps the two scopes’ answers apart on one hub', async () => {
    const s = hub();
    serve({ '/api/wall/mine': { canvases: ['/mine.mp4'] }, '/api/wall': { canvases: ['/pub.mp4'] } });
    const mine = renderHook(() => useWallClips(s, 'mine'));
    const pub = renderHook(() => useWallClips(s, 'hub'));
    await waitFor(() => expect(mine.result.current).toEqual([`${s.url}/mine.mp4`]));
    await waitFor(() => expect(pub.result.current).toEqual([`${s.url}/pub.mp4`]));
  });
});

describe('useWallClipsState', () => {
  it('tells "no answer yet" apart from "answered, and empty"', async () => {
    // The Discover hero asks for a single Canvas clip only once it KNOWS
    // there is no wall to be had; the two are different facts to it.
    const s = hub();
    serve({ '/api/wall': { canvases: [] } });
    const { result } = renderHook(() => useWallClipsState(s));
    expect(result.current).toEqual({ clips: [], settled: false });
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.clips).toEqual([]);
  });

  it('is unsettled and empty with no server, and asks nothing', async () => {
    const seen = serve({ '/api/wall': { canvases: ['/a.mp4'] } });
    const { result } = renderHook(() => useWallClipsState(null));
    expect(result.current).toEqual({ clips: [], settled: false });
    expect(seen).toEqual([]);
  });

  it('settles empty when the network refuses outright', async () => {
    const s = hub();
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    const { result } = renderHook(() => useWallClipsState(s));
    await waitFor(() => expect(result.current.settled).toBe(true));
    expect(result.current.clips).toEqual([]);
  });
});
