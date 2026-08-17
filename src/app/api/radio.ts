import { request, type ServerSession } from './http.ts';

// --- the endless station -----------------------------------------------------

/**
 * The next handful for a station. Called again whenever the queue runs low,
 * which is what makes it endless: the server holds no cursor, so the client
 * passes what it already has (`exclude`) and gets something else back.
 */
export async function fetchRadio(
  session: ServerSession,
  opts: {
    /** Start from this track's feel. */
    seed?: number | null;
    /** -1 calmer .. 1 harder. */
    energy?: number;
    /** 0 deep cuts .. 1 favourites. */
    familiar?: number;
    n?: number;
    /** Track ids already queued, so a page never repeats the last one. */
    exclude?: readonly number[];
    /** Blend with another account on this server. */
    with?: number | null;
  } = {},
  signal?: AbortSignal,
): Promise<number[]> {
  const q = new URLSearchParams();
  if (opts.seed != null) q.set('seed', String(opts.seed));
  if (opts.energy !== undefined) q.set('energy', String(opts.energy));
  if (opts.familiar !== undefined) q.set('familiar', String(opts.familiar));
  if (opts.n !== undefined) q.set('n', String(opts.n));
  if (opts.with != null) q.set('with', String(opts.with));
  if (opts.exclude && opts.exclude.length > 0) {
    // The tail is what matters - the server only needs to avoid what is still
    // ahead, and a URL is not the place for a whole listening history.
    q.set('exclude', opts.exclude.slice(-120).join(','));
  }
  const reply = await request<{ tracks: number[] }>(session.url, `/api/radio?${q}`, {
    token: session.token,
    signal,
  });
  return reply.tracks ?? [];
}

/** One account on this server, for the household surfaces. */
export interface HouseholdPerson {
  id: number;
  username: string;
  me: boolean;
}

/** Who else is on this server. Any signed-in listener may ask - see the
 *  endpoint's own note on why this is not the admin-only user list. */
export async function fetchHousehold(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<HouseholdPerson[]> {
  const reply = await request<{ people: HouseholdPerson[] }>(session.url, '/api/household', {
    token: session.token,
    signal,
  });
  return reply.people ?? [];
}
