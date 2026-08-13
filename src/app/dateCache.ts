import { isHeld, offlineSpace, pinTrack, unpinTrack } from './offline.ts';
import { streamUrl, trackIdFromPath, type ServerSession } from './server.ts';
import { isMobile } from './platform.ts';
import { isTauri, type Track } from './tauri.ts';

/**
 * Keeping the next stretch of Dates on the phone.
 *
 * A Date is judged in about four seconds - the cover moves, a snippet plays,
 * you swipe. Streaming each one at the moment it reaches the top of the deck
 * puts a network round trip inside that gesture, which is exactly where it is
 * most obvious: on a train, in a lift, on a hotel wifi, the deck stalls
 * between every card and the whole thing stops feeling like flicking through
 * records. Nothing about a Date needs to be live, either - the deck is already
 * decided and sitting in the library - so the songs can simply be here first.
 *
 * So the next {@link DATE_CACHE_TARGET} cards are pinned into the same offline
 * vault "Keep on this device" uses, and playback resolves them from disk
 * without knowing anything changed (see offline.ts's resolver).
 *
 * Two rules keep this from being the feature people disable:
 *
 *  - **It only ever takes room that is genuinely spare.** Free space is
 *    checked before each pin and the warmer stops at {@link SPACE_FLOOR},
 *    so a phone that is nearly full silently goes back to streaming rather
 *    than being the reason there is no space for photos.
 *  - **It only removes what it added.** The vault is shared with songs the
 *    user deliberately kept, so every auto-pin is recorded here and eviction
 *    consults that list. A song you asked to keep is never touched by the
 *    warmer, even once it has left the deck.
 */

/** How many cards ahead to hold. */
export const DATE_CACHE_TARGET = 20;

/** Room left alone. Below this the warmer does nothing and evicts what it can. */
const SPACE_FLOOR = 2 * 1024 * 1024 * 1024; // 2 GB

/** Paths the warmer pinned, so it can tell its own from a deliberate keep. */
const OWNED_KEY = 'attackfm-date-cached';

function owned(): Set<string> {
  try {
    const raw = localStorage.getItem(OWNED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((p): p is string => typeof p === 'string'));
  } catch {
    return new Set();
  }
}

function rememberOwned(paths: Set<string>): void {
  try {
    localStorage.setItem(OWNED_KEY, JSON.stringify([...paths]));
  } catch {
    // Losing the record only means the warmer forgets which pins were its
    // own - it will then leave them alone, which is the safe direction.
  }
}

interface Space {
  freeBytes: number | null;
  heldBytes: number;
}

async function space(): Promise<Space | null> {
  return offlineSpace();
}

/** Whether caching ahead makes sense at all here: a phone, with a vault. */
export function canCacheDates(): boolean {
  return isTauri() && isMobile;
}

let running = false;

/**
 * Brings the vault in line with the deck: the next {@link DATE_CACHE_TARGET}
 * cards held, anything the warmer previously held and no longer needs let go.
 *
 * Safe to call often - it returns immediately if a pass is already running,
 * and a pass that finds nothing to do costs one space check.
 */
export async function warmDates(deck: Track[], session: ServerSession | null): Promise<void> {
  if (!canCacheDates() || !session || running) return;
  running = true;
  try {
    const wanted = deck.slice(0, DATE_CACHE_TARGET);
    const wantedPaths = new Set(wanted.map((t) => t.path));
    const mine = owned();

    // Let go of cards that have been judged and moved on, before pinning
    // more: on a phone near the floor, the room for the next twenty is
    // exactly the room the last twenty are using.
    for (const path of [...mine]) {
      if (wantedPaths.has(path)) continue;
      await unpinTrack(path);
      mine.delete(path);
    }
    rememberOwned(mine);

    for (const track of wanted) {
      if (isHeld(track.path)) continue;
      const id = trackIdFromPath(track.path);
      if (id === null) continue;

      // Checked per track rather than once: twenty songs is a few hundred
      // megabytes, and the floor has to hold at the END of the run too.
      const room = await space();
      if (!room || room.freeBytes === null || room.freeBytes < SPACE_FLOOR) return;

      const ok = await pinTrack(track, streamUrl(session, id));
      if (!ok) continue;
      mine.add(track.path);
      rememberOwned(mine);
    }
  } catch {
    // A warmer that fails is a deck that streams, which is what it did
    // before. Never worth surfacing.
  } finally {
    running = false;
  }
}

/** Everything the warmer is holding, released. For the Settings pane's
 *  storage controls, which must be able to undo this without touching the
 *  songs the user kept on purpose. */
export async function releaseCachedDates(): Promise<void> {
  const mine = owned();
  for (const path of mine) await unpinTrack(path);
  rememberOwned(new Set());
}
