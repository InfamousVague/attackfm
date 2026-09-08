import type { Jam } from '../server.ts';

/**
 * When a room decides its host has stopped listening.
 *
 * Read by the queue panel and by the badge in the transport row, which both
 * say so in their own words - so the threshold and the clock it is measured
 * on are settled once, here, rather than twice in two components that could
 * disagree about whether the same room is live.
 */

/** How long a host's player may go unheard before the room says so. The
 *  host beats every 2.5 s; forty-five seconds is a backgrounded phone or a
 *  closed laptop, not a slow network. */
const HOST_QUIET_MS = 45_000;

/**
 * Whether the host's player has gone quiet: their last beat is older than
 * the room tolerates, measured on the HUB's clock (`now` and `hostSeenAt`
 * are both its), so two phones with different ideas of the time agree. An
 * older hub reports neither, and is never said to be waiting.
 */
export function hostWaiting(room: Jam): boolean {
  if (room.hostSeenAt === undefined) return false;
  const now = room.now ?? room.receivedAt ?? Date.now();
  return now - room.hostSeenAt > HOST_QUIET_MS;
}
