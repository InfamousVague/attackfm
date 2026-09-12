/*
 * When a delegating hub's download box counts as quiet - the app's copy of the
 * hub's rule, so a row stops spinning at the same moment the hub starts
 * letting its cancel through. Its own file because incoming.tsx exports
 * components, and fast refresh wants a file of components to export nothing
 * else.
 */

/** The hub's own threshold for a quiet download box (collector.rs BOX_QUIET_MS). */
export const BOX_QUIET_MS = 20 * 60 * 1000;

/**
 * Whether the box a delegating hub hands its downloads to has gone quiet.
 * Only a hub that delegates has a box to be quiet; one that has never heard
 * from a box at all (`peerSeenAt` null) counts as quiet.
 */
export function isBoxQuiet(delegates: boolean, peerSeenAt: number | null, now: number): boolean {
  if (!delegates) return false;
  return peerSeenAt == null || now - peerSeenAt >= BOX_QUIET_MS;
}
