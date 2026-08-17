//! The cache's persistence and notification core: the ledger of entries the
//! cache owns, the hand-deleted denials, the size limit, and the listeners
//! every mutation notifies. Module-level state here has exactly one owner -
//! this module; everything else reaches it through these exports.

const LEDGER_KEY = 'attackfm-autocache';
export const DENY_KEY = 'attackfm-cache-deny';

/**
 * Songs the listener deleted from the device by hand.
 *
 * Without this, deleting an auto-cached file is a promise the next sweep
 * quietly breaks: the song is still hot, so it is downloaded right back -
 * which is why the old Storage pane refused to offer delete on cache-owned
 * rows at all. The file browser offers it, so the refusal becomes a denial
 * the planner respects. Cleared by Clear-cache (a fresh start is a fresh
 * start), and counted in the sweep receipt so the exclusions are visible
 * rather than a mystery about why a liked song never arrives.
 */
export function deniedKeys(): Set<string> {
  try {
    const raw = localStorage.getItem(DENY_KEY);
    return raw ? new Set(Object.keys(JSON.parse(raw) as Record<string, number>)) : new Set();
  } catch {
    return new Set();
  }
}

export function denyKey(key: string): void {
  try {
    const raw = localStorage.getItem(DENY_KEY);
    const all = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    all[key] = Date.now();
    localStorage.setItem(DENY_KEY, JSON.stringify(all));
  } catch {
    // The delete still happened; the song may just come back next sweep.
  }
  for (const fn of listeners) fn();
}

const LIMIT_KEY = 'attackfm-cache-limit';

/** The default ceiling. Fifteen gigabytes is a few thousand lossy songs or a
 *  few hundred lossless ones - enough to hold everything anyone plays in a
 *  normal month without being the largest thing on the phone. */
export const DEFAULT_LIMIT_BYTES = 15 * 1024 ** 3;

/** What the settings pane offers. Off is a real choice: someone always on
 *  their own wifi may simply not want the space used. */
export const LIMIT_CHOICES = [0, 2, 5, 10, 15, 25, 50, 100].map((gb) => gb * 1024 ** 3);

export function cacheLimitBytes(): number {
  try {
    const raw = localStorage.getItem(LIMIT_KEY);
    if (raw !== null) {
      const n = Number(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch {
    // Fall through to the default.
  }
  return DEFAULT_LIMIT_BYTES;
}

export function setCacheLimitBytes(bytes: number): void {
  try {
    localStorage.setItem(LIMIT_KEY, String(Math.max(0, Math.round(bytes))));
  } catch {
    // Applies for this run regardless.
  }
  for (const fn of listeners) fn();
}

const listeners = new Set<() => void>();

export function onCacheChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Fire every onCacheChange subscriber. The one listener set lives here; the
 *  manifest, sweep and schedule modules call this rather than keeping a
 *  second set of their own. */
export function notifyCacheChange(): void {
  for (const fn of listeners) fn();
}

// --- the ledger: which entries this cache owns -----------------------------

type Ledger = Record<string, number>;

export function readLedger(): Ledger {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    const parsed = raw ? (JSON.parse(raw) as Ledger) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function writeLedger(ledger: Ledger): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    // A lost ledger costs correctness in one direction only: entries become
    // indistinguishable from manual pins, so they stop being evicted rather
    // than starting to be. The cache stalls; it never eats someone's pins.
  }
}

/** Every key this cache owns, for callers separating the automatic half from
 *  the hand-kept one without re-reading storage per row. */
export function autoCachedKeys(): Set<string> {
  return new Set(Object.keys(readLedger()));
}
