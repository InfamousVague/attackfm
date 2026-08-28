/**
 * What the import server's outbox is doing.
 *
 * A peer that downloads for you copies each finished song to the hub
 * afterwards, in its own background queue. That queue is the one part of the
 * arrangement with no other symptom: a file that fails to copy still played
 * fine on the peer, so without this readout "the hub never got it" is
 * something you find out weeks later when the peer is off.
 *
 * `/api/peersync` always answers 200, including on a box that is a hub and has
 * no outbox at all (`configured: false`), so asking is never an error - it is
 * how a server says "not my job".
 */

import { useEffect, useState } from 'react';
import type { ServerSession } from '../server.ts';
import { request } from '../api/http.ts';

export interface PeerSyncCounts {
  pending: number;
  uploading: number;
  done: number;
  skipped: number;
  failed: number;
}

export interface PeerSyncStall {
  reason: string;
  /** Unix seconds. */
  since: number;
}

export interface PeerSyncItem {
  path: string;
  state: string;
  attempts: number;
  error: string;
  /** Unix seconds. */
  at: number;
}

export interface PeerSyncStatus {
  configured: boolean;
  /** Host only - the peer never hands out anything shaped like a URL with a
   *  token in it, and the client has no use for one. */
  hub: string;
  counts: PeerSyncCounts;
  stall: PeerSyncStall | null;
  recent: PeerSyncItem[];
  /**
   * Whether this box is taking downloads on the hub's behalf, and why not when
   * it is not. The hub can see that its offers are going unanswered but never
   * why; only the box that would do the downloading knows that.
   */
  claiming: { canDownload: boolean; why: string } | null;
}

const EMPTY_COUNTS: PeerSyncCounts = { pending: 0, uploading: 0, done: 0, skipped: 0, failed: 0 };

export async function fetchPeerSyncStatus(target: ServerSession): Promise<PeerSyncStatus> {
  const raw = await request<Partial<PeerSyncStatus>>(target.url, '/api/peersync', {
    token: target.token,
  });
  return {
    configured: raw.configured === true,
    hub: raw.hub ?? '',
    counts: { ...EMPTY_COUNTS, ...(raw.counts ?? {}) },
    stall: raw.stall ?? null,
    recent: raw.recent ?? [],
    // Absent on a server too old to report it - not the same as "fine".
    claiming: raw.claiming ?? null,
  };
}

/** Re-queue failed pushes. Admin-only server-side, hence the caller's gate. */
export async function retryPeerSync(target: ServerSession, path?: string): Promise<number> {
  const res = await request<{ requeued?: number }>(target.url, '/api/peersync/retry', {
    method: 'POST',
    token: target.token,
    body: JSON.stringify(path ? { path } : {}),
  });
  return res.requeued ?? 0;
}

/** How often to re-read while a pane is open. The queue moves at upload speed,
 *  not at frame speed, and this is a background copy nobody is watching land. */
const POLL_MS = 30_000;

/**
 * The status of one server's outbox, for as long as the caller is mounted.
 *
 * Never throws and never surfaces an error: an older server has no such route
 * and a peer can be off the network, and neither is something the person
 * reading a settings pane can act on. Null means "nothing to say", which the
 * callers render as nothing at all.
 */
export function usePeerSyncStatus(target: ServerSession | null): PeerSyncStatus | null {
  const [status, setStatus] = useState<PeerSyncStatus | null>(null);
  const url = target?.url ?? '';
  const token = target?.token ?? '';

  useEffect(() => {
    if (!url || !token) {
      setStatus(null);
      return;
    }
    let live = true;
    const tick = () => {
      void fetchPeerSyncStatus({ url, token, streamToken: '', username: '', isAdmin: false })
        .then((s) => {
          if (live) setStatus(s);
        })
        .catch(() => {
          if (live) setStatus(null);
        });
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => {
      live = false;
      window.clearInterval(id);
    };
  }, [url, token]);

  return status;
}
