import type { Track } from '../core/tauri.ts';
import type { ServerSession } from '../server.ts';
import { request } from '../api/http.ts';

/**
 * Smart shuffle: the queue keeps going, and the library keeps offering.
 *
 * Ordinary shuffle can only ever return songs already in front of you, so a
 * list you have heard through stays a list you have heard through. Smart
 * shuffle asks the server what ELSE belongs in this queue - the same taste
 * model the playlist suggester uses, pointed at whatever is actually playing
 * rather than at a saved list - and works those in among the shuffled ones.
 * The server says where each one came from: something SIMILAR to the queue,
 * something NEW to the library, or something the listener has had on REPEAT.
 * That lane rides with the song into the queue panel, so a stranger in the
 * line comes with its reason.
 *
 * The pool is fetched once per queue and then spent one at a time, because the
 * alternative is a network round trip in the middle of a track change. It
 * refills when the queue itself changes - and once more when it has been spent
 * to the bottom, so a long session does not run dry after six picks.
 *
 * Everything here degrades to plain shuffle: no session, no server, a server
 * too old for the route, a queue too short to have a character - each returns
 * nothing, and the caller picks from the queue exactly as it did before.
 *
 * Restored after a spell parked (Matt asked for it out, then back in). The
 * wiring lives in player/Player.tsx: the `smart` state and the cycle's third
 * step, the prime/clear effect on queue change, and the spend in pickNext. The
 * badge that marks the mode, and the one that marks a pick in the queue, are
 * in styles/09-summoned-search.css.
 */

/** Where the server dealt an enhancer from. Absent on a hub from before lanes. */
export type EnhancerLane = 'similar' | 'new' | 'repeat';

/** One song the DJ has to offer, and the lane it came down. */
export interface Enhancer {
  track: Track;
  lane: EnhancerLane | null;
}

/**
 * The mode's accessible name, on every control that shows it. A sentence
 * rather than a label because the sparkle is the only visible difference from
 * plain shuffle, and a reader who cannot see it should still be told what the
 * third state does.
 */
export const SMART_SHUFFLE_LABEL =
  'Smart shuffle: the DJ mixes in new music, your on-repeat songs and similar tracks';

const MIN_QUEUE = 3;
/**
 * How often a shuffle step spends an enhancer rather than a queue track. One
 * in four keeps the queue recognisably itself - this is a shuffle with
 * suggestions in it, not a radio station wearing a shuffle icon.
 */
const ENHANCE_EVERY = 4;

let pool: Enhancer[] = [];
let poolKey = '';
let loading = false;
/**
 * Whether the pool under `poolKey` is worth asking for again once spent. A
 * fetch that came back with songs may have more behind it; an empty answer,
 * a 404 or a refusal is the server's last word on this queue, and asking
 * again on every step would be a network round trip for nothing.
 */
let refillable = false;
/** A prime that arrived while another was in flight, replayed when it lands -
 *  the queue moved during the round trip and the answer is already stale. */
let pending: Parameters<typeof primeEnhancers> | null = null;
/**
 * Every pick handed out, by path, with the lane it came down. This is what
 * the queue panel reads to badge a row, and what keeps the pool's cache key
 * honest: a pick slotted into the queue is the DJ's addition, not a change of
 * the listener's question, so it must not look like a new queue to answer.
 * Pruned to the live queue on every prime - once a pick has left the line it
 * is an ordinary song again.
 */
const handed = new Map<string, EnhancerLane | null>();

/** A queue's identity for caching: its membership, order-independent - a
 *  reshuffle of the same songs is the same question - and minus the DJ's own
 *  additions, which are the answer rather than the question. */
function keyOf(queue: Track[]): string {
  return queue
    .map((t) => t.path)
    .filter((path) => !handed.has(path))
    .sort()
    .join('');
}

function laneOf(raw: unknown): EnhancerLane | null {
  return raw === 'similar' || raw === 'new' || raw === 'repeat' ? raw : null;
}

/** Forget picks that are no longer in the line they were dealt into. */
function pruneHanded(queue: Track[]): void {
  if (handed.size === 0) return;
  const live = new Set(queue.map((t) => t.path));
  for (const path of Array.from(handed.keys())) if (!live.has(path)) handed.delete(path);
}

/**
 * Warm the enhancer pool for this queue. Safe to call often: it only goes to
 * the network when the queue has actually changed, or when the pool it fetched
 * for this queue has been spent.
 */
export async function primeEnhancers(
  session: ServerSession | null,
  queue: Track[],
  resolve: (id: number) => Track | undefined,
  trackIdOf: (path: string) => number | null,
): Promise<void> {
  pruneHanded(queue);
  if (!session || queue.length < MIN_QUEUE) {
    pool = [];
    poolKey = '';
    refillable = false;
    return;
  }
  const key = keyOf(queue);
  if (loading) {
    pending = [session, queue, resolve, trackIdOf];
    return;
  }
  if (key === poolKey && (pool.length > 0 || !refillable)) return;
  // A different queue is a different question: drop the old pool NOW, not
  // when the answer lands, or a step taken while the request is in flight
  // deals a suggestion computed for the queue that just left.
  if (key !== poolKey) pool = [];
  loading = true;
  refillable = false;
  try {
    const ids = queue.map((t) => trackIdOf(t.path)).filter((id): id is number => id !== null);
    if (ids.length < MIN_QUEUE) {
      // A local-only queue has no ids the server could reason about.
      pool = [];
      poolKey = key;
      return;
    }
    const reply = await request<{ trackIds?: number[]; lanes?: Record<string, unknown> }>(
      session.url,
      '/api/queue/enhance',
      {
        method: 'POST',
        token: session.token,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trackIds: ids, count: 6 }),
      },
    );
    // `lanes` arrived with the lanes themselves; a hub from before them
    // answers ids alone, and those picks are simply the DJ's, unlabelled.
    const lanes = reply.lanes ?? {};
    const inQueue = new Set(queue.map((t) => t.path));
    pool = (reply.trackIds ?? [])
      .map((id): Enhancer | null => {
        const track = resolve(id);
        return track ? { track, lane: laneOf(lanes[String(id)]) } : null;
      })
      .filter((e): e is Enhancer => e !== null)
      .filter((e) => !inQueue.has(e.track.path) && !handed.has(e.track.path));
    poolKey = key;
    refillable = pool.length > 0;
  } catch {
    // A server without the route, or offline: plain shuffle, no complaint.
    pool = [];
    poolKey = key;
  } finally {
    loading = false;
    if (pending) {
      const again = pending;
      pending = null;
      void primeEnhancers(...again);
    }
  }
}

/**
 * The enhancer for this shuffle step, if this is one of the steps that gets
 * one. `stepsTaken` is how many shuffle picks the queue has made, so the
 * cadence is counted rather than rolled - a coin flip clusters, and clustering
 * is exactly what would make this feel like the app hijacking the queue.
 * `taken` is every path the pick must not be: the recent trail, and the queue
 * as it stands now (a song the listener added since the pool was fetched is
 * theirs to hear as a queue track, not the DJ's to deal again).
 */
export function nextEnhancer(stepsTaken: number, taken: Set<string>): Enhancer | null {
  if (pool.length === 0) return null;
  if (stepsTaken % ENHANCE_EVERY !== ENHANCE_EVERY - 1) return null;
  const index = pool.findIndex((e) => !taken.has(e.track.path));
  if (index === -1) return null;
  const pick = pool.splice(index, 1)[0];
  if (!pick) return null;
  handed.set(pick.track.path, pick.lane);
  return pick;
}

/**
 * The queue panel's badge for a song the DJ dealt into the line, or null for
 * a song nobody dealt. The lane is named when the hub said it; a pick from an
 * older hub is still a pick, just an unexplained one.
 */
export function enhancerLabel(path: string): string | null {
  if (!handed.has(path)) return null;
  switch (handed.get(path)) {
    case 'new':
      return 'DJ pick · New';
    case 'repeat':
      return 'DJ pick · On repeat';
    case 'similar':
      return 'DJ pick · Similar';
    default:
      return 'DJ pick';
  }
}

/**
 * Forget the pool - a different queue is a different question, and a mode
 * switched off should not keep a stale answer for when it comes back. The
 * picks already dealt into `keep` stay badged: they were the DJ's and still
 * are, whatever the button says now.
 */
export function clearEnhancers(keep: Track[] = []): void {
  pool = [];
  poolKey = '';
  refillable = false;
  pending = null;
  pruneHanded(keep);
}
