import type { Track } from '../core/tauri.ts';

/**
 * Put the needle back where the update took it from.
 *
 * An update is the one interruption the app inflicts on itself. Everything
 * else that stops a song is the listener's doing - a pause, a skip, closing
 * the app - and coming back to silence after those is correct. Restarting to
 * install a version they did not ask for is different: the app took the song
 * away, so the app owes it back, at the second it was taken and still playing
 * if it was playing.
 *
 * NOT the same thing as resumeSync.ts, and deliberately not built on it. That
 * answers "what was I in the middle of, on my other device" - it goes to the
 * registry, needs an account, is off by default behind a privacy switch, is
 * throttled to once every twenty seconds and ignores the first twenty of any
 * song. Every one of those is right for a cross-device offer and wrong here.
 * This is the same device, the same second, across a reload it caused; it must
 * work signed out, with that switch off, having sent nothing anywhere, and be
 * exact rather than up to twenty seconds stale.
 *
 * WHY LOCALSTORAGE AND NOT SESSION. sessionStorage would be the natural fit -
 * its lifetime is "until the app closes", which is nearly the lifetime of an
 * update - but only nearly: applyStagedBundle reloads today and a future
 * restart-to-update that genuinely relaunches the process would drop it, and
 * the handoff would be silently lost on exactly the path most likely to
 * replace it. The TTL below does the same job without depending on which one
 * it turns out to be.
 */

const KEY = 'attackfm-deck-handoff';

/**
 * How long a stashed deck may wait to be picked up.
 *
 * The reload it is written for happens within a second, so this is not about
 * the normal path - it is the ceiling on the abnormal one. A stash only ever
 * exists because an update was applied, but if that update then failed to come
 * up at all, the listener's next launch is a recovery and should not also be
 * ambushed by music. Long enough for a slow relaunch, far short of "later".
 */
const TTL_MS = 5 * 60_000;

/**
 * How much of the queue travels.
 *
 * The current track is stored whole because Now Playing has to draw it before
 * any library has loaded. The rest is context for skipping, and an unbounded
 * queue - a shuffled library is thousands of tracks - would put megabytes
 * through a synchronous localStorage write on the way out of a reload, which
 * is the worst possible moment to be slow.
 */
const QUEUE_CAP = 300;

export interface DeckHandoff {
  /** The track that was playing, whole: the sheet draws it before any library
   *  has loaded. */
  track: Track;
  /** The tracks around it, so skip still works on the other side. */
  queue: Track[];
  /** Seconds into the song, on the bar's clock. */
  position: number;
  /** Whether it was actually playing, as opposed to sitting paused. */
  playing: boolean;
  at: number;
}

type Snapshot = () => DeckHandoff | null;

let snapshot: Snapshot | null = null;

/**
 * The player says how to ask it what is on the deck.
 *
 * A channel rather than a store because the answer has to be exact at the
 * instant of the reload, and anything kept continuously fresh would be a
 * localStorage write every few seconds for a moment that almost never comes.
 */
export function provideDeckSnapshot(fn: Snapshot): () => void {
  snapshot = fn;
  return () => {
    if (snapshot === fn) snapshot = null;
  };
}

/**
 * Write down what is on the deck, on the way out.
 *
 * Synchronous on purpose: the caller's next statement is location.reload(),
 * and anything deferred would not survive it. A silent no-op when no player is
 * mounted, which is the launch-gate path - there is no song to keep because
 * the app never opened.
 */
export function stashDeck(): void {
  try {
    const now = snapshot?.() ?? null;
    if (!now?.track) return;
    const at = Math.max(0, Math.floor(now.queue.findIndex((t) => t.path === now.track.path)));
    const from = Math.max(0, at - Math.floor(QUEUE_CAP / 2));
    localStorage.setItem(
      KEY,
      JSON.stringify({ ...now, queue: now.queue.slice(from, from + QUEUE_CAP) }),
    );
  } catch {
    // A full or unavailable store costs the listener their place, and nothing
    // else. Never worth failing an update over.
  }
}

/**
 * Read once per launch, and only ever once.
 *
 * Two callers need this - App seeds the deck from it, the player seeks to it -
 * and they must agree. So the read happens once, the stored copy is removed
 * immediately (a handoff that is not consumed on the very next launch is a
 * handoff whose launch failed, and replaying it later would be a haunting),
 * and both callers are served the same object from memory afterwards.
 */
let taken: DeckHandoff | null | undefined;

export function deckHandoff(): DeckHandoff | null {
  if (taken !== undefined) return taken;
  taken = read();
  return taken;
}

/** Applied: nobody should act on it again this launch. */
export function clearDeckHandoff(): void {
  taken = null;
}

function read(): DeckHandoff | null {
  try {
    const raw = localStorage.getItem(KEY);
    localStorage.removeItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeckHandoff>;
    if (!parsed || typeof parsed !== 'object') return null;
    const track = parsed.track;
    if (!track || typeof track.path !== 'string') return null;
    if (typeof parsed.at !== 'number' || Date.now() - parsed.at > TTL_MS) return null;
    const position =
      typeof parsed.position === 'number' && Number.isFinite(parsed.position) && parsed.position > 0
        ? parsed.position
        : 0;
    return {
      track,
      queue: Array.isArray(parsed.queue) && parsed.queue.length ? parsed.queue : [track],
      position,
      playing: parsed.playing === true,
      at: parsed.at,
    };
  } catch {
    return null;
  }
}
