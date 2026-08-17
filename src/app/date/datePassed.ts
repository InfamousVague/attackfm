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

export function readPassed(): Set<number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PASSED_KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((n): n is number => typeof n === 'number'));
  } catch {
    // A torn entry reads as no passes, which only means a rerun of old cards.
  }
  return new Set();
}

export function writePassed(passed: Set<number>): void {
  try {
    localStorage.setItem(PASSED_KEY, JSON.stringify([...passed].slice(-PASSED_CAP)));
  } catch {
    // Storage refusing just means passes forget across launches.
  }
}
