//! When the sweep runs: the six-hour cadence, the launch delay, the heart /
//! Date-deck nudge, and the guard that keeps two passes from overlapping.
//! The sweeping / lastCompleteAt / activeSession state lives HERE, once.

import { type ServerSession } from '../server.ts';
import { setNativeSyncing } from '../player/androidAudio.ts';
import { isTauri } from '../core/tauri.ts';
import { sweepCache } from './cacheSweep.ts';

// --- when it runs ----------------------------------------------------------

/** How often to reconsider, once settled. Taste moves over days, not minutes,
 *  and every pass costs a `/api/home` and a favourites read. */
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;
/** A pause after launch, so the cache never competes with the first song
 *  someone opened the app to play. */
const FIRST_SWEEP_DELAY_MS = 90_000;

let sweeping = false;

/** Run a pass unless one is already going. Safe to call from anywhere. */
export async function sweepIfIdle(session: ServerSession): Promise<void> {
  if (sweeping || !isTauri()) return;
  sweeping = true;
  setNativeSyncing(true);
  try {
    await sweepCache(session);
    lastCompleteAt = Date.now();
  } catch {
    // A failed pass is a pass; the next one will find the same work to do.
  } finally {
    sweeping = false;
    setNativeSyncing(false);
  }
}

/** When a sweep last ran to the END. A phone locked mid-download freezes the
 *  webview and the pass dies where it stood; comparing this against the last
 *  START is how the schedule knows to go again instead of waiting six hours
 *  with half a plan on disk. */
let lastCompleteAt = 0;

// The session the sweeps are running for, so a nudge from elsewhere in the
// app (the heart, the Date deck) does not need one threaded to it.
let activeSession: ServerSession | null = null;
let nudgeTimer: number | undefined;

/**
 * Ask for a sweep soon, rather than at the next six-hour mark.
 *
 * The scheduled cadence is right for drift - taste moves slowly - but wrong
 * for a stated wish. Hearting a song is the listener saying "this one", and
 * six hours later is not when they expect it to be on the phone; they expect
 * it the way a message sends: now-ish, without being asked twice. Debounced a
 * few seconds so hearting a run of songs costs one pass, not one per press.
 */
export function nudgeSweep(): void {
  if (!isTauri() || !activeSession) return;
  window.clearTimeout(nudgeTimer);
  nudgeTimer = window.setTimeout(() => {
    const live = activeSession;
    if (live && !document.hidden) void sweepIfIdle(live);
  }, 4000);
}

/**
 * Keep the cache current for as long as a session is live.
 *
 * Foreground only, and never while the app is hidden: this downloads whole
 * songs, and a phone in a pocket is exactly where a background fetch turns
 * into a battery and data complaint nobody asked for.
 */
export function startCacheSweeps(session: ServerSession): () => void {
  if (!isTauri()) return () => {};
  activeSession = session;
  let stopped = false;
  let last = 0;

  const maybe = () => {
    if (stopped || document.hidden) return;
    // The full gap only applies to a pass that FINISHED; an interrupted one
    // re-runs on the next look, held to a minute so a flapping screen does
    // not turn into a download storm.
    const finished = lastCompleteAt >= last;
    if (Date.now() - last < (finished ? SWEEP_EVERY_MS : 60_000)) return;
    last = Date.now();
    void sweepIfIdle(session);
  };

  const first = window.setTimeout(() => {
    last = Date.now();
    void sweepIfIdle(session);
  }, FIRST_SWEEP_DELAY_MS);
  const timer = window.setInterval(maybe, 30 * 60 * 1000);
  document.addEventListener('visibilitychange', maybe);

  return () => {
    stopped = true;
    if (activeSession === session) activeSession = null;
    window.clearTimeout(first);
    window.clearInterval(timer);
    document.removeEventListener('visibilitychange', maybe);
  };
}
