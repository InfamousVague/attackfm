import { RegistryError, fetchJamShare, type JamShare } from '../servers/registry.ts';
import type { useJam } from './jam.tsx';

/** The groove provider's value, as its hook hands it out. */
type JamValue = ReturnType<typeof useJam>;

/**
 * Getting INTO a groove from a code or a link - the part that is the same
 * whether the code arrived as a tapped link (JamLinkBridge) or was typed
 * into the "Have a code?" sheet (JoinGrooveSheet).
 *
 * A link names a hub as well as a room, and the app has to be on that hub
 * to walk in; the registry says where the room is, the hub says whether you
 * may enter. Those two questions, asked in that order, are what this module
 * is - so the two doors cannot drift apart on what "the same server" means
 * or on what a hub's no sounds like.
 *
 * The landing itself is not here. A join that works is announced by the
 * provider (jam.tsx `land`: the toast, the player up, the deck open), the
 * same for every way in; this module only reports which way it went.
 */

/** Same box, ignoring the trailing slash and the scheme a link might carry
 *  differently from the one the app signed in with. */
export function sameHub(a: string, b: string): boolean {
  return hubHost(a).toLowerCase() === hubHost(b).toLowerCase();
}

/** A hub as people say it: the host and path, no scheme, no trailing slash.
 *  Named by ADDRESS on purpose - hubs are called things like "AttackFM" by
 *  default, and "this one is on AttackFM" reads as a sentence about the app. */
export function hubHost(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/**
 * The registry's answer for a code: the share, or `null` when it knows no
 * link by that name. Anything else - offline, a 500 - throws, because "we
 * could not ask" and "there is no such link" call for different words.
 */
export async function lookupGroove(code: string): Promise<JamShare | null> {
  try {
    return await fetchJamShare(code);
  } catch (e) {
    if (e instanceof RegistryError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Walk into a room on this hub by its id. `join()` never throws: it says a
 * refusal out loud itself and answers false, so this only tells the caller
 * whether the provider has landed them. The registry row outlives the room;
 * a false here is the hub saying the room is not there any more, which is
 * the one answer only it can give.
 */
/** 'ended' is the hub's answer (the room is gone); 'failed' is no answer at
 *  all (offline, a timeout) - and those must not read the same, or a dropped
 *  connection tells somebody their friend's groove is over. */
export async function walkIn(jam: JamValue, id: string): Promise<'joined' | 'ended' | 'failed'> {
  try {
    return (await jam.join(id)) ? 'joined' : 'ended';
  } catch {
    return 'failed';
  }
}

/** How an attempt to enter went, when it did not simply work. */
export type GrooveEntry =
  | { kind: 'joined' }
  /** The link is real, but names a room on a different server. */
  | { kind: 'elsewhere'; share: JamShare }
  /** Nothing answers to it - no link by that name, and (for a typed code)
   *  no room on this hub either. */
  | { kind: 'missing'; bare: boolean }
  /** The link is real and on this server, and the hub said the room is gone. */
  | { kind: 'ended'; share: JamShare }
  /** The registry could not be asked at all. */
  | { kind: 'failed' };

/**
 * Enter a groove from whatever was typed: a share code, a link, or the
 * room's own id read off a friend's deck.
 *
 * The registry first - a share says which hub the room is on, and if that
 * is not this one there is nothing to try. No share, and the code was
 * typed rather than pasted from a link: it may be the ROOM's id (the deck
 * prints that one as "Code"), which only the hub knows, so the hub is
 * asked directly. The hub's no for an unknown id and for an ended room are
 * the same no, so the words for it cover both.
 */
export async function enterGroove(
  jam: JamValue,
  hubUrl: string,
  ref: { code: string; bare: boolean },
): Promise<GrooveEntry> {
  let share: JamShare | null = null;
  let unreachable = false;
  try {
    share = await lookupGroove(ref.code);
  } catch {
    unreachable = true;
  }
  if (share) {
    if (!sameHub(hubUrl, share.hubUrl)) return { kind: 'elsewhere', share };
    const walked = await walkIn(jam, share.jamId);
    return walked === 'joined' ? { kind: 'joined' } : walked === 'failed' ? { kind: 'failed' } : { kind: 'ended', share };
  }
  if (!ref.bare) return unreachable ? { kind: 'failed' } : { kind: 'missing', bare: false };
  // A typed code the registry does not know - or could not be asked about -
  // may still be a room on this hub. The hub is the only thing that can say.
  const walked = await walkIn(jam, ref.code);
  if (walked === 'joined') return { kind: 'joined' };
  if (walked === 'failed') return { kind: 'failed' };
  return unreachable ? { kind: 'failed' } : { kind: 'missing', bare: true };
}

// --- the door to the sheet -----------------------------------------------------
//
// The "Have a code?" row lives in the groove deck's popover, and a sheet
// rendered inside that popover is unmounted by the tap that opens it - the
// panel dismisses, and takes the sheet with it. So the sheet is hoisted to
// app level (App.tsx, beside JamLinkBridge) and opened through this: a tiny
// store, replayed on subscribe so an opener that fires before the sheet has
// mounted is not lost. Same shape as the deep-link stores.

let held: string | null = null;
const listeners = new Set<(seed: string) => void>();

/** Raise the Join-a-groove sheet, optionally with something already in the
 *  field (a code that arrived some other way). */
export function openGrooveCode(seed = ''): void {
  held = seed;
  for (const fn of listeners) fn(seed);
}

/** Be told when the sheet is asked for - now, or the moment it is. */
export function onGrooveCode(fn: (seed: string) => void): () => void {
  listeners.add(fn);
  if (held !== null) fn(held);
  return () => {
    listeners.delete(fn);
  };
}

/** Taken once: a closed sheet must not reopen on the next subscriber. */
export function clearGrooveCode(): void {
  held = null;
}
