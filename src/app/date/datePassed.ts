/** How long each introduction plays before looping back to its start. */
export const SNIPPET_SECONDS = 25;
/** How many upcoming songs stay buffered ahead of the current one. */
export const BUFFER_AHEAD = 8;

/** Where the snippet begins: past the intro, capped so a long track does not
 *  open on its bridge. Short tracks just play from the top. */
export function snippetStart(duration: number): number {
  if (!Number.isFinite(duration) || duration < 45) return 0;
  return Math.min(duration * 0.3, 60);
}

/** How far a card must travel to count as a verdict rather than a wobble. */
export const VERDICT_PX = 90;
/** How long the fling takes; the deck underneath has already moved on. */
export const FLING_MS = 280;

// Passes are remembered across sessions so the deck moves forward. Ids, not
// paths: a re-synced library keeps ids stable, and the cap keeps a heavy
// swiper from growing the entry forever.
const PASSED_KEY = 'attackfm-date-passed';
const PASSED_CAP = 800;

/*
 * The ledger is OBSERVABLE, and that is not decoration.
 *
 * It used to be a function that read localStorage, and only Music Date itself
 * ever called it - so every other surface that counted auditions counted the
 * passed ones too. The Music Date chip said "172 waiting" over a deck that was
 * empty, because 172 was every audition this listener owned and the deck had
 * already ruled on all of them. A count that disagrees with the room it opens
 * is worse than no count.
 *
 * So a pass now NOTIFIES, and anything showing a number can subscribe. The
 * cache also means the parse happens once rather than on every render of every
 * counter.
 */
let cache: Set<number> | null = null;
let version = 0;
const listeners = new Set<() => void>();

function load(): Set<number> {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(localStorage.getItem(PASSED_KEY) ?? '[]') as unknown;
    cache = Array.isArray(parsed)
      ? new Set(parsed.filter((n): n is number => typeof n === 'number'))
      : new Set();
  } catch {
    // A torn entry reads as no passes, which only means a rerun of old cards.
    cache = new Set();
  }
  return cache;
}

/** A COPY, because Music Date mutates its own set in place and then writes it
 *  back; handing out the cache would let that edit the ledger unannounced. */
export function readPassed(): Set<number> {
  return new Set(load());
}

/** The ledger itself, for read-only callers that just want to test membership. */
export function passedSet(): ReadonlySet<number> {
  return load();
}

/** Bumped on every write; the snapshot a subscriber compares. */
export function passedVersion(): number {
  return version;
}

export function subscribePassed(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function writePassed(passed: Set<number>): void {
  cache = new Set(passed);
  version += 1;
  try {
    localStorage.setItem(PASSED_KEY, JSON.stringify([...passed].slice(-PASSED_CAP)));
  } catch {
    // Storage refusing just means passes forget across launches.
  }
  // After the write, so a listener that re-reads sees the new ledger.
  for (const fn of listeners) fn();
}
