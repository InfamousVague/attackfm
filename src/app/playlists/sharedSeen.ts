import { useSyncExternalStore } from 'react';

/**
 * Which shared playlists this device has OPENED.
 *
 * A list a friend shares with you arrives in the store the same way your own
 * do, and until you open it nothing tells the two apart on the shelf. This
 * is the "have I looked yet" ledger behind the New badge in the Library's
 * "Shared with you" section and behind the standing `playlist-shared`
 * notice: opening the page writes the id here, the badge comes off, and the
 * bell row is dismissed. Per-device on purpose - "new to me on this phone"
 * is a fact about this phone, exactly like playlistRecency beside it.
 *
 * Keyed by hub AND id (see `sharedSeenKey`): playlist ids are numbers a hub
 * hands out, and two hubs will both have a list 7.
 *
 * A module store with a stable snapshot, so the shelf can subscribe: the
 * page marks a list seen while the shelf is one Back away and has to be
 * showing the change when you get there.
 */
const KEY = 'attackfm-playlist-shared-seen';
const CAP = 500;

function read(): ReadonlySet<string> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((s): s is string => typeof s === 'string'));
  } catch {
    // A torn entry reads as "nothing seen yet", which only costs a badge.
  }
  return new Set();
}

let seen: ReadonlySet<string> = read();
const listeners = new Set<() => void>();

function write(next: ReadonlySet<string>): void {
  seen = next;
  try {
    localStorage.setItem(KEY, JSON.stringify([...next].slice(-CAP)));
  } catch {
    // Storage refusing just means the badge forgets across launches.
  }
  for (const cb of listeners) cb();
}

/** The ledger key for one list on one hub. `hub` is the session url ('' for
 *  a local library, where no list is ever shared). */
export function sharedSeenKey(hub: string, id: string): string {
  return `${hub}#${id}`;
}

export function isSharedSeen(hub: string, id: string): boolean {
  return seen.has(sharedSeenKey(hub, id));
}

export function markSharedSeen(hub: string, id: string): void {
  const key = sharedSeenKey(hub, id);
  if (seen.has(key)) return;
  write(new Set([...seen, key]));
}

/** The owner took the list away (or shared it afresh): the next share of
 *  the same id is new again. */
export function forgetSharedSeen(hub: string, id: string): void {
  const key = sharedSeenKey(hub, id);
  if (!seen.has(key)) return;
  const next = new Set(seen);
  next.delete(key);
  write(next);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function snapshot(): ReadonlySet<string> {
  return seen;
}

/** The whole ledger, re-rendering on change. Test membership with
 *  `sharedSeenKey`. */
export function useSharedSeen(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
