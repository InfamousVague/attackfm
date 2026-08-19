import { request, type ServerSession } from './http.ts';

/**
 * Talking to the separator: one place, for everything that wants a song in parts.
 *
 * Three surfaces grew their own copy of this — the Stems room on Now Playing,
 * the sound console and the pads board — and each got a different subset of
 * it right. The separator itself was never duplicated (there is one demucs, in
 * server/src/stems.rs); what was duplicated is the far easier thing to get
 * wrong: which URL to call, which of them takes a token, and how to tell "not
 * separated yet" from "this server cannot separate at all".
 *
 * Both of the copies that were not Pads had a real defect. The Stems room built
 * its POST with a trailing slash, which axum does not normalise, so asking for
 * a separation answered 404 and the panel printed the word "not found". The
 * console never issued a POST at all, so it waited forever on any song
 * that Pads had not already taken apart.
 */

/** The six parts, in the order the server lists them (server/src/stems.rs). */
export const STEM_ORDER = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'] as const;

export type Stem = (typeof STEM_ORDER)[number];

export interface StemStatus {
  /** The job: none | queued | running | done | failed. */
  state: string;
  /** The server's own diagnosis when state is failed - always worth showing
   *  verbatim, since it names the actual cause (a timeout, a missing file). */
  error: string;
  /**
   * Whether this server can separate AT ALL - i.e. it found demucs.
   *
   * The one honest source for "your server needs the stems tools". Distinct
   * from an empty stem list, which only means "not yet".
   */
  available: boolean;
  parts: number;
  /** 0..1 while running, or null on a server too old to report it. */
  progress: number | null;
  phase: string | null;
  /** How many jobs are ahead of this one. */
  queuedAhead: number | null;
  stems: { stem: string; bytes?: number }[];
}

function shape(raw: unknown): StemStatus {
  const r = (raw ?? {}) as Partial<StemStatus> & { stems?: { stem: string }[] };
  return {
    state: typeof r.state === 'string' ? r.state : 'none',
    error: typeof r.error === 'string' ? r.error : '',
    // Absent means an older server that always had the tools if it answered.
    available: r.available !== false,
    parts: typeof r.parts === 'number' ? r.parts : 0,
    progress: typeof r.progress === 'number' ? r.progress : null,
    phase: typeof r.phase === 'string' ? r.phase : null,
    queuedAhead: typeof r.queuedAhead === 'number' ? r.queuedAhead : null,
    stems: Array.isArray(r.stems) ? r.stems : [],
  };
}

/** What exists for this song. Asks for nothing to be made. */
export async function stemStatus(
  session: ServerSession,
  trackId: number,
  signal?: AbortSignal,
): Promise<StemStatus> {
  return shape(
    await request<unknown>(session.url, `/api/stems/${trackId}`, {
      token: session.token,
      signal,
    }),
  );
}

/**
 * Queue a separation.
 *
 * NO trailing slash. The route is `/api/stems/{track}` and axum 0.8 does not
 * normalise a path, so `/api/stems/1/` matches nothing and answers 404 - which
 * is precisely how the Stems room's button came to report "not found" instead
 * of separating anything.
 */
export async function requestStems(
  session: ServerSession,
  trackId: number,
): Promise<{ state: string }> {
  return request<{ state: string }>(session.url, `/api/stems/${trackId}`, {
    method: 'POST',
    token: session.token,
  });
}

/**
 * One stem, or a slice of one, for `fetch`.
 *
 * HEADER auth only - pass `stemAuthHeaders`. The handler calls
 * `auth::require_caller(&state.db, &headers)` and reads no token from the
 * query, whatever the comment above it says. So this URL must never be handed
 * to an `<audio src>`, which cannot carry a header.
 */
export function stemBlockUrl(
  session: ServerSession,
  trackId: number,
  stem: string,
  at?: { from: number; len: number; flac?: boolean },
): string {
  const base = `${session.url}/api/stems/${trackId}/${stem}`;
  if (!at) return base;
  const flac = at.flac ? '&fmt=flac' : '';
  return `${base}?from=${at.from.toFixed(3)}&len=${at.len.toFixed(3)}${flac}`;
}

export function stemAuthHeaders(session: ServerSession): HeadersInit {
  return { authorization: `Bearer ${session.token}` };
}

