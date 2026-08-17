import { trackIdFromPath, type ServerSession } from '../server.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The client half of the listen log: what actually got heard, sent to the
 * server as events.
 *
 * The stats page and the curator's self-tuning both feed on this, which sets
 * the honesty bar: minutes count only while sound is actually coming out
 * (`audible` - playing, unmuted, volume up), not while a track is paused or
 * buffering under a spinner. A play that never reached five seconds is a blip
 * and is not an event at all.
 *
 * One event per sitting with a track: it opens when the deck takes the track
 * and closes when the deck moves on (or the app closes). `completed` means 85%
 * of the file was heard - which folds in the natural end without needing the
 * `ended` event - and `skipped` means the listener bailed inside thirty
 * seconds, the Spotify sense of a skip. The two are not exhaustive: leaving a
 * song halfway is neither a skip nor a completion, and the curator treats it
 * as the shrug it is.
 *
 * Events queue in localStorage and flush in batches, so a dead network or a
 * closed laptop loses nothing - the next launch sends what the last one could
 * not. Only server tracks (`afm://`) are logged; a local file has no track id
 * to log against and no server that would care.
 */

export interface ListenEvent {
  trackId: number;
  startedAt: number;
  msListened: number;
  durationMs: number | null;
  completed: boolean;
  skipped: boolean;
  context: string;
}

const OUTBOX_KEY = 'attackfm-listen-outbox';
const FLUSH_MS = 20_000;
/** Under this, the sitting was a blip, not a listen. */
const MIN_MS = 5_000;
/** Bailing before this is a skip. */
const SKIP_MS = 30_000;
/** Hearing this share of the file is a completion. */
const DONE_SHARE = 0.85;
/** Outbox cap - a device that cannot reach the server for a month should not
 *  grow an unbounded ledger. Oldest events go first; stats prefer recent. */
const OUTBOX_CAP = 2_000;

function readOutbox(): ListenEvent[] {
  try {
    const raw = localStorage.getItem(OUTBOX_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as ListenEvent[]) : [];
  } catch {
    return [];
  }
}

function writeOutbox(events: readonly ListenEvent[]): void {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(events.slice(-OUTBOX_CAP)));
  } catch {
    // A full store costs history, not playback.
  }
}

function enqueue(event: ListenEvent): void {
  writeOutbox([...readOutbox(), event]);
}

/** Sends the outbox, oldest first. Batches stay under the server's cap; a
 *  refused batch (4xx) is dropped - it will never become acceptable - while a
 *  network failure leaves everything for the next try. */
async function flush(session: ServerSession, keepalive = false): Promise<void> {
  const outbox = readOutbox();
  if (outbox.length === 0) return;
  const batch = outbox.slice(0, 100);
  try {
    const res = await fetch(`${session.url}/api/listens`, {
      method: 'POST',
      keepalive,
      headers: {
        authorization: `Bearer ${session.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ events: batch }),
    });
    if (res.ok || (res.status >= 400 && res.status < 500)) {
      writeOutbox(readOutbox().slice(batch.length));
    }
  } catch {
    // Offline; the outbox holds.
  }
}

/** What the reporter reads once a second. A snapshot getter rather than
 *  arguments, so the Player wires it once to a ref and never re-subscribes. */
export interface ListenSnapshot {
  track: Track | null;
  /** Sound is actually coming out. */
  audible: boolean;
  /** Seconds, 0 until metadata lands. */
  duration: number;
  session: ServerSession | null;
  /** The privacy switch. False drops a sitting at the moment it would be
   *  written - same rule as the play counter: flipping it mid-song never
   *  retroactively logs what began under "off". */
  record: boolean;
}

interface Sitting {
  path: string;
  trackId: number;
  startedAt: number;
  ms: number;
  /** Best duration seen during the sitting, ms. */
  durationMs: number | null;
}

export function createListenReporter(read: () => ListenSnapshot): { dispose: () => void } {
  let sitting: Sitting | null = null;
  let lastTick = performance.now();
  let lastFlush = 0;

  const finalize = () => {
    const s = sitting;
    sitting = null;
    if (!s || s.ms < MIN_MS) return;
    if (!read().record) return;
    const done = s.durationMs !== null && s.ms >= s.durationMs * DONE_SHARE;
    enqueue({
      trackId: s.trackId,
      startedAt: s.startedAt,
      msListened: Math.round(s.ms),
      durationMs: s.durationMs,
      completed: done,
      skipped: !done && s.ms < SKIP_MS,
      context: '',
    });
  };

  const tick = () => {
    const now = performance.now();
    // Clamped: a tab the OS froze for an hour did not play for an hour.
    const dt = Math.min(2_000, now - lastTick);
    lastTick = now;

    const snap = read();
    const path = snap.track?.path ?? null;
    const id = path === null ? null : trackIdFromPath(path);

    if (sitting && sitting.path !== path) finalize();
    if (!sitting && path !== null && id !== null) {
      sitting = { path, trackId: id, startedAt: Date.now(), ms: 0, durationMs: null };
    }
    if (sitting) {
      if (snap.audible) sitting.ms += dt;
      if (snap.duration > 0) sitting.durationMs = Math.round(snap.duration * 1000);
    }

    if (snap.session && now - lastFlush > FLUSH_MS) {
      lastFlush = now;
      void flush(snap.session);
    }
  };

  const interval = window.setInterval(tick, 1_000);

  // The app closing mid-song is the ordinary end of a sitting, not an edge
  // case: finalize and push what we can on the way out. `keepalive` lets the
  // request outlive the page.
  const onHide = () => {
    if (document.visibilityState !== 'hidden') return;
    finalize();
    const snap = read();
    if (snap.session) void flush(snap.session, true);
  };
  document.addEventListener('visibilitychange', onHide);

  return {
    dispose: () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onHide);
      finalize();
      const snap = read();
      if (snap.session) void flush(snap.session);
    },
  };
}
