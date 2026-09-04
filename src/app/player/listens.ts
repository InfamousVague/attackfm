import { originFromPath, trackIdFromPath, type ServerSession } from '../server.ts';
import { normalise, sessionForOrigin } from '../servers/sessions.ts';
import { deviceLabel } from '../api/http.ts';
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
  /** The server the track lives on. A song from Kevin's hub is logged to
   *  Kevin's hub - this is what stops a listen being credited to whatever
   *  server happened to be current. Absent on events written before origins
   *  existed, which flush to the current session as they always did. */
  origin?: string;
  trackId: number;
  startedAt: number;
  msListened: number;
  durationMs: number | null;
  completed: boolean;
  skipped: boolean;
  context: string;
  /** Deck position when the sitting closed - WHERE they bailed, not how long
   *  they heard. A seek makes the two differ, and the difference is the point. */
  endedAtMs?: number;
  /** Times the volume went up mid-song. Nobody turns up a song they are about
   *  to skip. */
  volumeUps?: number;
  /** Times they rewound to hear a part again - the most deliberate approval a
   *  listener gives without a heart. */
  seekBacks?: number;
  /** Where it was heard: the device, and the route the sound took. */
  device?: string;
}

/*
 * Which surface started the current queue.
 *
 * The schema has carried a context column end-to-end since the ledger was
 * built, and this file hardcoded '' into it - so no surface could ever learn
 * whether its own picks were finished or skipped, which is the prerequisite
 * for every feedback loop the DJ wants. Set at queue start (playFrom knows
 * who called it) and it rides every listen of that sitting until the next
 * queue replaces it.
 */
let playSurface = '';
export function markPlaySurface(name: string): void {
  playSurface = name;
}

/*
 * Where the sound is coming out. The Player sets it from the same state the
 * device picker reads: this device's own output, another Connect seat, a
 * Chromecast, or a speaker on the network. A car is a route too, when the
 * shell can say so. Folded into `device` with the platform name, so a sitting
 * reads "iPhone/car" or "macOS/speaker" - the same taste plays differently in
 * each, and the curator can learn which.
 */
let playRoute = 'local';
export function markPlayRoute(route: string): void {
  playRoute = route;
}

const OUTBOX_KEY = 'attackfm-listen-outbox';
const FLUSH_MS = 20_000;
/** Under this, the sitting was a blip, not a listen - a mis-tap, the wrong
 *  song in a queue, the moment before "not this one". Ten seconds, by the
 *  listener's own rule: nothing said inside them counts either way. */
const MIN_MS = 10_000;
/** A jump back of at least this is a rewind, not jitter. */
const SEEK_BACK_MS = 3_000;
/** A volume rise of at least this is a hand on the dial, not a fade. */
const VOLUME_STEP = 0.04;
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
  /*
   * One batch per SERVER. Events carry the origin of the track they describe;
   * each group goes to that server's own session (or the current one for
   * legacy events with none). A server this device no longer holds a session
   * for keeps its events in the outbox rather than misfiling them elsewhere.
   */
  const current = normalise(session.url);
  const groups = new Map<string, ListenEvent[]>();
  for (const e of outbox) {
    const key = e.origin ? normalise(e.origin) : current;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(e);
  }
  for (const [origin, events] of groups) {
    const target = origin === current ? session : sessionForOrigin(origin);
    if (!target || normalise(target.url) !== origin) continue;
    const batch = events.slice(0, 100);
    try {
      const res = await fetch(`${target.url}/api/listens`, {
        method: 'POST',
        keepalive,
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ events: batch.map(({ origin: _o, ...rest }) => rest) }),
      });
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        const sent = new Set(batch);
        writeOutbox(readOutbox().filter((e) => !sent.has(e) && !batch.some((b) => b.startedAt === e.startedAt && b.trackId === e.trackId && (b.origin ?? '') === (e.origin ?? ''))));
      }
    } catch {
      // Offline; the outbox holds.
    }
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
  /** Deck position, seconds. Read each tick for the bail point and rewinds. */
  position: number;
  /** 0..1. Read each tick for hands on the dial. */
  volume: number;
}

interface Sitting {
  path: string;
  origin: string | null;
  trackId: number;
  startedAt: number;
  ms: number;
  /** Best duration seen during the sitting, ms. */
  durationMs: number | null;
  /** Last deck position seen, ms - where they were when the sitting closed. */
  lastPosMs: number;
  lastVolume: number;
  volumeUps: number;
  seekBacks: number;
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
      ...(s.origin ? { origin: s.origin } : {}),
      trackId: s.trackId,
      startedAt: s.startedAt,
      msListened: Math.round(s.ms),
      durationMs: s.durationMs,
      completed: done,
      skipped: !done && s.ms < SKIP_MS,
      context: playSurface,
      endedAtMs: Math.round(s.lastPosMs),
      volumeUps: s.volumeUps,
      seekBacks: s.seekBacks,
      device: `${deviceLabel()}/${playRoute}`,
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
      // The origin the path names, or the current server for a bare one -
      // captured at the START of the sitting, so a switch mid-song still
      // credits the box the song came from.
      const origin = originFromPath(path) ?? snap.session?.url ?? null;
      sitting = {
        path,
        origin,
        trackId: id,
        startedAt: Date.now(),
        ms: 0,
        durationMs: null,
        lastPosMs: snap.position * 1000,
        lastVolume: snap.volume,
        volumeUps: 0,
        seekBacks: 0,
      };
    }
    if (sitting) {
      if (snap.audible) sitting.ms += dt;
      if (snap.duration > 0) sitting.durationMs = Math.round(snap.duration * 1000);
      /*
       * Two things a listener does with their hands that say more than the
       * clock does. A jump BACKWARD of a few seconds or more is a rewind -
       * they wanted that part again. A rise in volume mid-song is a hand on
       * the dial, and nobody turns up a song they are about to skip. Both
       * counted only while the same song is in the deck, and both from the
       * once-a-second snapshot - no new plumbing in the Player.
       */
      const posMs = snap.position * 1000;
      if (snap.audible && sitting.lastPosMs - posMs >= SEEK_BACK_MS) sitting.seekBacks += 1;
      sitting.lastPosMs = posMs;
      if (snap.volume - sitting.lastVolume >= VOLUME_STEP) sitting.volumeUps += 1;
      sitting.lastVolume = snap.volume;
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
