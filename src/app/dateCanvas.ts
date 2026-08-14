import { fetchCanvas, trackIdFromPath, type ServerSession } from './server.ts';
import type { Track } from './tauri.ts';

/**
 * Canvas clips for the Date deck, fetched one card ahead.
 *
 * A Date is judged in about four seconds, and the clip is most of what there
 * is to judge - so a card promoted to the top with its video still arriving
 * shows a still cover for the first second or two, which reads as the page
 * being slow rather than the network being a network. The fix is the same as
 * the audio slots above it: the NEXT card's clip is fetched while the current
 * one is being watched, so promotion finds it already here.
 *
 * Held as blob object URLs rather than warmed over HTTP, deliberately. An
 * ordinary fetch would fill the HTTP cache, but WebKit loads <video> sources
 * through its media stack with Range requests, and those are not guaranteed
 * to be answered from that cache - the bytes could be fetched twice and the
 * promotion still not instant. A blob is bytes already in memory: the video
 * starts from it synchronously, network or no network.
 *
 * The window is small (a handful of clips, a few MB each) and old entries are
 * revoked as new ones land, so this never grows with the deck.
 */

/** Clips held ready. Generously past the two cards warmed ahead, so the one
 *  on screen is never near the eviction edge. */
const CAP = 8;

/** path -> object URL, or null for "looked up; this song has no clip". */
const settled = new Map<string, string | null>();
/** path -> the fetch already running, so a promotion mid-warm can await it
 *  instead of downloading the same bytes beside it. */
const inFlight = new Map<string, Promise<string | null>>();
/** Insertion order, for eviction. */
const order: string[] = [];

/**
 * The warmed clip for a card: an object URL, null for "has no clip", or
 * undefined for "never warmed" - callers fall back to their own fetch then.
 */
export function warmedDateCanvas(path: string): string | null | undefined {
  return settled.get(path);
}

/** The warm still in the air for a card, if one is. */
export function pendingDateCanvas(path: string): Promise<string | null> | null {
  return inFlight.get(path) ?? null;
}

/** Start warming one card's clip. Idempotent. A failed MEDIA fetch leaves no
 *  trace, so the card's own fallback behaves as if nothing was warmed; a
 *  failed LOOKUP settles as "no clip", because fetchCanvas folds its own
 *  failures into null - which is exactly the face the live path would have
 *  shown for the same blip, so the card is never worse off than unwarmed. */
export function warmDateCanvas(session: ServerSession, track: Track): void {
  if (settled.has(track.path) || inFlight.has(track.path)) return;

  const run = (async (): Promise<string | null> => {
    const url = await fetchCanvas(
      session,
      track.title,
      track.artist,
      undefined,
      trackIdFromPath(track.path),
    );
    // "No clip" is an answer worth keeping: promotion should show the cover
    // at once rather than asking again.
    if (!url) return null;
    const reply = await fetch(url);
    if (!reply.ok) throw new Error(`clip fetch ${reply.status}`);
    const blob = await reply.blob();
    if (blob.size === 0) throw new Error('empty clip');
    return URL.createObjectURL(blob);
  })();

  inFlight.set(track.path, run);
  run
    .then((result) => {
      settled.set(track.path, result);
      order.push(track.path);
      // Let the oldest go. Only ever entries a promotion has long passed:
      // the cap sits well beyond the warm-ahead depth.
      while (order.length > CAP) {
        const old = order.shift();
        if (old === undefined) break;
        const held = settled.get(old);
        if (held) URL.revokeObjectURL(held);
        settled.delete(old);
      }
    })
    .catch(() => {
      // Left unsettled on purpose: the card's own fetch remains the fallback.
    })
    .finally(() => {
      inFlight.delete(track.path);
    });
}

/** Warm a cover the ordinary way - art URLs are immutable, so an Image is
 *  enough to have the bytes local before the card surfaces. */
export function warmArt(url: string | null): void {
  if (!url) return;
  const img = new Image();
  img.src = url;
}
