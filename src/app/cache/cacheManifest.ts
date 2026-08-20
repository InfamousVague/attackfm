//! The sweep's manifest and receipt: what the last pass planned song by song,
//! and the plain-language SweepReport the Offline pane shows. The manifest
//! array is owned HERE - the sweep replaces it via setManifest and moves
//! states via setManifestState, never by holding a second array.

import { notifyCacheChange } from './cacheStore.ts';

/**
 * The sweep's manifest: every song the last pass planned, with where it got.
 *
 * The receipt (SweepReport) is the sentence; this is the ledger behind it -
 * song by song, art and all, so "132 would not download" is inspectable
 * instead of a number. States move live while a sweep runs (the pane
 * re-renders off the same listeners the counters use), and the finished
 * manifest is persisted so the pane still shows the last run after a
 * restart. Capped on write: a 15 GB plan can hold thousands of songs, and
 * the pane only ever shows the head.
 */
export interface ManifestEntry {
  key: string;
  title: string;
  artist: string;
  /** Full art URL, resolved at plan time while the session is in hand. */
  art: string | null;
  bytes: number;
  state: 'waiting' | 'downloading' | 'done' | 'failed';
  reason?: string;
}

const MANIFEST_KEY = 'attackfm-autocache-manifest';
const MANIFEST_CAP = 300;

let manifest: ManifestEntry[] = (() => {
  try {
    const raw = localStorage.getItem(MANIFEST_KEY);
    return raw ? (JSON.parse(raw) as ManifestEntry[]) : [];
  } catch {
    return [];
  }
})();

export function sweepManifest(): ManifestEntry[] {
  return manifest;
}

/** Replace the manifest wholesale - the sweep publishes its plan through this
 *  so there is only ever the one array. */
export function setManifest(next: ManifestEntry[]): void {
  manifest = next;
}

export function persistManifest(): void {
  try {
    localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest.slice(0, MANIFEST_CAP)));
  } catch {
    // The live view still works; only the restart memory is lost.
  }
}

export function setManifestState(key: string, state: ManifestEntry['state'], reason?: string): void {
  const entry = manifest.find((e) => e.key === key);
  if (!entry) return;
  entry.state = state;
  if (reason) entry.reason = reason;
  notifyCacheChange();
}

/**
 * What the last pass did, and why it did nothing when it did nothing.
 *
 * Every failure in this file is caught and shrugged off - a favourites call
 * that will not load is "one fewer input", a download that fails is `false` -
 * which is right for a background job that must never take the app down, and
 * wrong for anyone trying to work out why their liked songs are not on their
 * phone. The sweep was unobservable: no error, no log, no count, just an empty
 * folder. This is the receipt.
 */
export interface SweepReport {
  at: number;
  /** Plain-language outcome, for the Offline pane to show as-is. */
  note: string;
  kept: number;
  failed: number;
  /** The distinct download failures, commonest first, each tagged with the
   *  host it came from - "which server, and what it said" is the whole
   *  diagnosis for a sweep that planned 130 downloads and landed 2. */
  failReasons?: { reason: string; n: number }[];
  /** Ranked songs this server's index could not name or size, so they were
   *  never candidates - a stale index shows up here rather than nowhere. */
  skippedUnknown: number;
  /**
   * Wanted, sizable, and left out anyway because the budget ran out.
   *
   * The difference between "your playlists are on your phone" and "as much of
   * them as fits" - which is otherwise indistinguishable from the outside, since
   * a budget too small to hold everything just produces a smaller number with no
   * explanation attached. Zero is the meaningful value: it means the ranked set
   * fit whole.
   */
  budgetShort?: number;
  liked: number;
  limitBytes: number;
}

const REPORT_KEY = 'attackfm-autocache-report';

export function writeReport(next: SweepReport): void {
  try {
    localStorage.setItem(REPORT_KEY, JSON.stringify(next));
  } catch {
    // The pane simply shows nothing; the sweep itself is unaffected.
  }
  notifyCacheChange();
}

/** Put the last receipt away. The tiles keep their colours - they are the
 *  truth about the disk - this only silences the text until the next pass
 *  writes a new one. */
export function dismissSweepReport(): void {
  try {
    localStorage.removeItem(REPORT_KEY);
  } catch {
    // Then it stays; harmless.
  }
  notifyCacheChange();
}

/** Wind every failed tile back to waiting, so a retry reads as a retry rather
 *  than a wall of red that flickers. The next sweep re-attempts anything not
 *  on disk anyway - this is presentation, and the honest kind: the state IS
 *  waiting again the moment a new pass is asked for. */
export function resetFailedManifest(): void {
  let changed = false;
  for (const entry of manifest) {
    if (entry.state === 'failed') {
      entry.state = 'waiting';
      delete entry.reason;
      changed = true;
    }
  }
  if (changed) {
    persistManifest();
    notifyCacheChange();
  }
}

/** The last pass's receipt, or null if none has run on this device. */
export function lastSweep(): SweepReport | null {
  try {
    const raw = localStorage.getItem(REPORT_KEY);
    return raw ? (JSON.parse(raw) as SweepReport) : null;
  } catch {
    return null;
  }
}
