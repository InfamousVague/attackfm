import type { DjMatchExplanation } from '../api/dj.ts';

/**
 * Why the DJ picked each queued song - kept, at last.
 *
 * The server has always computed a one-line reason and a seven-part score
 * breakdown for every track in a trait queue, and the client kept exactly one
 * of them alive for twelve seconds as a toast before discarding the rest. A
 * sommelier who explains one bottle and shrugs at the case is not much of a
 * sommelier. The map holds the latest mix's reasons; the queue panel reads it
 * per row. Replaced whole on each new mix - reasons describe a set, not a
 * lifetime.
 */
const reasons = new Map<number, string>();

export function rememberDjReasons(explanations: DjMatchExplanation[]): void {
  reasons.clear();
  for (const e of explanations) {
    if (e.reason.trim()) reasons.set(e.trackId, e.reason.trim());
  }
}

export function djReason(trackId: number | null): string | undefined {
  if (trackId === null) return undefined;
  return reasons.get(trackId);
}
