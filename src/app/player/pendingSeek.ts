/*
 * "Open that track AND land here."
 *
 * Changing track and seeking are two separate things and the second cannot be
 * done until the first has loaded, so anything wanting a spot in ANOTHER
 * section has to leave word. Without it, jumping to a bookmark two chapters
 * back would switch to that section and then be overruled by the automatic
 * resume, landing at wherever you last stopped in it - which is precisely the
 * spot the bookmark existed to be different from.
 *
 * Deliberately a single slot, not a queue: a person can only mean one
 * destination at a time, and the newest ask wins. It is CONSUMED by the reader,
 * so a stale want cannot ambush a later, ordinary play of the same section.
 */

let pending: { path: string; positionMs: number } | null = null;

export function setPendingSeek(path: string, positionMs: number): void {
  pending = { path, positionMs: Math.max(0, positionMs) };
}

/** The spot asked for in this track, taken (and cleared) if there is one. */
export function takePendingSeek(path: string): number | null {
  if (!pending || pending.path !== path) return null;
  const { positionMs } = pending;
  pending = null;
  return positionMs;
}

/** Drop the want without acting on it - for a play that means "from the top". */
export function clearPendingSeek(): void {
  pending = null;
}
