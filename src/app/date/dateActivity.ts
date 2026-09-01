/**
 * A pulse that fires whenever a date is judged, so the Music Date chip's count
 * can correct itself the moment you come back from a sitting.
 *
 * The chip's number is two halves: your OWNED auditions (which already move in
 * real time - a pass writes the observable ledger in datePassed.ts) and the
 * server's PREVIEW POOL. The pool half was fetched once when the chip mounted
 * and never again, so judging a dozen preview cards and returning left the
 * tile still promising the old count over a smaller pool. Preview verdicts go
 * straight to the server (dateCandidateVerdict), leaving nothing local to
 * subtract - so rather than shadow-count them, the chip just re-asks the
 * server for the total, and this is the nudge that tells it to.
 *
 * A version rather than an event payload: subscribers re-read whatever they
 * derive, they do not accumulate deltas. Deliberately NOT persisted - it only
 * has to survive as long as both the deck and the chip are mounted together,
 * which is the whole of one sitting.
 */
let version = 0;
const listeners = new Set<() => void>();

/** Called by Music Date after each verdict - owned or preview, keep or pass. */
export function bumpDateActivity(): void {
  version += 1;
  for (const fn of listeners) fn();
}

export function dateActivityVersion(): number {
  return version;
}

export function subscribeDateActivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
