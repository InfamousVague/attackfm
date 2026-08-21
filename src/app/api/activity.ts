import { request } from './http.ts';
import type { ServerSession } from './http.ts';

/**
 * The server's activity feed: what its background machinery has been doing.
 *
 * A bounded, append-only log of CYCLE-level events - a song pulled into stems,
 * an AI pass starting and finishing, a collector sweep - kept on the server in
 * the `activity_events` table and read back in id order. It exists for two
 * readers with one need each: the verbose-notifications watcher, which turns
 * new rows into bell rows, and the Local AI pane, which shows the owner what
 * the model has been up to. One table serving both is the point; a second
 * channel for either would be a second thing to keep in step.
 *
 * Events are server-wide rather than per user. The prefetcher takes songs
 * apart library-wide with no owner on the job, and the AI passes run for
 * everyone, so there is no one person to address - the reader's own verbose
 * switch is the opt-in.
 *
 * Polled, not pushed. The only live socket is the per-user Connect hub and a
 * notice frame on it would reach only a device with a stream token open; a
 * poll on `since` reaches every signed-in caller and costs one small request.
 */
export type ActivityState = 'started' | 'done' | 'failed' | 'info';

export interface ActivityEvent {
  id: number;
  /** Unix SECONDS, like every other server timestamp - run it through msOf(). */
  at: number;
  /** 'stems' | 'ai' | 'collector' | 'imports' | 'server' - open set. */
  source: string;
  /** What happened within the source: 'separate', 'fast-profile', 'curate', ... */
  kind: string;
  state: ActivityState;
  /**
   * The stable job key that pairs a start with its finish - `stems:<trackId>`,
   * `ai:fast-profile:<runId>`. The client uses it as the notice id so the
   * completion replaces the start row rather than sitting beside it.
   */
  key: string;
  title: string;
  body: string;
  trackId?: number | null;
  detail?: Record<string, unknown> | null;
}

export interface ActivityPage {
  events: ActivityEvent[];
  /** The newest id on the server, whether or not it was in this page. */
  latestId: number;
}

/**
 * Events after `sinceId` (exclusive), oldest first. `sinceId` of 0 asks for
 * the most recent `limit` rows - which a watcher should treat as a SEED (mark
 * the position, raise nothing), or a fresh install would announce a week of
 * history at once. Throws ServerError(404) on a hub that predates the route;
 * callers treat that as "not here yet" and go quiet, not as a fault.
 */
export async function fetchActivity(
  session: ServerSession,
  sinceId: number,
  limit = 50,
  signal?: AbortSignal,
): Promise<ActivityPage> {
  const q = new URLSearchParams({ since: String(sinceId), limit: String(limit) });
  return request<ActivityPage>(session.url, `/api/activity?${q}`, { token: session.token, signal });
}
