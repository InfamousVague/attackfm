import type { Track } from '../core/tauri.ts';
import type { ServerSession } from '../server.ts';
import { request } from '../api/http.ts';

/**
 * Smart shuffle: the queue keeps going, and the library keeps offering.
 *
 * PARKED. Matt asked for this out of the app for now, so nothing imports this
 * module - it is kept whole rather than deleted because the reason was "for
 * now" and the work here is the part that would be tedious to rebuild: the
 * fetch-once-per-queue pool, the one-in-four spend, and the degrade-to-plain
 * paths for no session, no server, an old server and a short queue.
 *
 * To bring it back: restore the `smart` state and the cycle's third step in
 * player/Player.tsx (the note there says where), re-add the prime/clear effect
 * on queue change, and put the enhancer spend back in pickNext. The badge that
 * marked the mode lived in styles/09-summoned-search.css and is described in
 * the comment that replaced it.
 *
 * Ordinary shuffle can only ever return songs already in front of you, so a
 * list you have heard through stays a list you have heard through. Smart
 * shuffle asks the server what ELSE belongs in this queue - the same taste
 * model the playlist suggester uses, pointed at whatever is actually playing
 * rather than at a saved list - and works those in among the shuffled ones.
 *
 * The pool is fetched once per queue and then spent one at a time, because the
 * alternative is a network round trip in the middle of a track change. It
 * refills when the queue itself changes.
 *
 * Everything here degrades to plain shuffle: no session, no server, a server
 * too old for the route, a queue too short to have a character - each returns
 * nothing, and the caller picks from the queue exactly as it did before.
 */

const MIN_QUEUE = 3;
/**
 * How often a shuffle step spends an enhancer rather than a queue track. One
 * in four keeps the queue recognisably itself - this is a shuffle with
 * suggestions in it, not a radio station wearing a shuffle icon.
 */
const ENHANCE_EVERY = 4;

let pool: Track[] = [];
let poolKey = '';
let loading = false;

/** A queue's identity for caching: its membership, order-independent - a
 *  reshuffle of the same songs is the same question. */
function keyOf(queue: Track[]): string {
  return queue
    .map((t) => t.path)
    .sort()
    .join('');
}

/**
 * Warm the enhancer pool for this queue. Safe to call often: it only goes to
 * the network when the queue has actually changed.
 */
export async function primeEnhancers(
  session: ServerSession | null,
  queue: Track[],
  resolve: (id: number) => Track | undefined,
  trackIdOf: (path: string) => number | null,
): Promise<void> {
  if (!session || queue.length < MIN_QUEUE) {
    pool = [];
    poolKey = '';
    return;
  }
  const key = keyOf(queue);
  if (key === poolKey || loading) return;
  loading = true;
  try {
    const ids = queue.map((t) => trackIdOf(t.path)).filter((id): id is number => id !== null);
    if (ids.length < MIN_QUEUE) return;
    const reply = await request<{ trackIds: number[] }>(session.url, '/api/queue/enhance', {
      method: 'POST',
      token: session.token,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trackIds: ids, count: 6 }),
    });
    pool = (reply.trackIds ?? [])
      .map(resolve)
      .filter((t): t is Track => t !== undefined)
      .filter((t) => !queue.some((q) => q.path === t.path));
    poolKey = key;
  } catch {
    // A server without the route, or offline: plain shuffle, no complaint.
    pool = [];
    poolKey = key;
  } finally {
    loading = false;
  }
}

/**
 * The enhancer for this shuffle step, if this is one of the steps that gets
 * one. `stepsTaken` is how many shuffle picks the queue has made, so the
 * cadence is counted rather than rolled - a coin flip clusters, and clustering
 * is exactly what would make this feel like the app hijacking the queue.
 */
export function nextEnhancer(stepsTaken: number, played: Set<string>): Track | null {
  if (pool.length === 0) return null;
  if (stepsTaken % ENHANCE_EVERY !== ENHANCE_EVERY - 1) return null;
  const index = pool.findIndex((t) => !played.has(t.path));
  if (index === -1) return null;
  return pool.splice(index, 1)[0] ?? null;
}

/** Forget the pool - a different queue is a different question. */
export function clearEnhancers(): void {
  pool = [];
  poolKey = '';
}
