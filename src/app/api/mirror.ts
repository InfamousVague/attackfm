import { request, type ServerSession } from './http.ts';

/** How far a library copy has got. */
export interface MirrorStatus {
  running: boolean;
  total: number;
  copied: number;
  skipped: number;
  failed: number;
  note: string;
}

/**
 * Ask THIS server to pull another library into itself.
 *
 * The destination does the work, which is what lets a copy be started from a
 * phone anywhere: the source only has to be reachable, and it already is. The
 * source's credentials travel in the body because the destination has to read
 * a library it has no account on.
 */
export async function startMirror(
  session: ServerSession,
  source: { url: string; token: string; streamToken: string },
  /** Carry only what the source is actually listened to, rather than all of
   *  it. The destination sizes the set to its own free disk. See hot.rs. */
  hot?: { minPlays?: number },
): Promise<void> {
  await request(session.url, '/api/mirror/start', {
    token: session.token,
    method: 'POST',
    body: JSON.stringify({
      sourceUrl: source.url,
      token: source.token,
      streamToken: source.streamToken,
      ...(hot ? { hot } : {}),
    }),
  });
}

export interface HotBar {
  minPlays: number;
  tracks: number;
  bytes: number;
}

/**
 * How big the listened-to set is on a server, at each bar - so the size of
 * the thing can be seen before a copy is started rather than discovered
 * while it runs.
 */
export async function fetchHotSummary(source: {
  url: string;
  streamToken: string;
}): Promise<{ bars: HotBar[]; liked: number; libraryTracks: number }> {
  return request(
    source.url,
    `/api/hot/summary?t=${encodeURIComponent(source.streamToken)}`,
    {},
  );
}

export async function fetchMirrorStatus(session: ServerSession): Promise<MirrorStatus> {
  const out = await request<Partial<MirrorStatus>>(session.url, '/api/mirror/status', {
    token: session.token,
  });
  return {
    running: out.running ?? false,
    total: out.total ?? 0,
    copied: out.copied ?? 0,
    skipped: out.skipped ?? 0,
    failed: out.failed ?? 0,
    note: out.note ?? '',
  };
}
