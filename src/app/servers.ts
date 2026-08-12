//! The servers this device has been signed into, remembered.
//!
//! The session store keeps ONE server - the one you are listening from - and
//! signing into another replaces it. That is right for playback and wrong for
//! memory: someone who belongs to their own hub and two friends' should not
//! have to keep the addresses in their head to move between them. So every
//! successful sign-in leaves a card here, and the Profile page turns the cards
//! back into one-tap switches (membership is re-proved by the registry on
//! every entry - this list holds no tokens, only where and what).

const KEY = 'attackfm-known-servers';

export interface KnownServer {
  url: string;
  /** The server's own name, backfilled the first time /api/server answers. */
  name?: string;
  /** The username this device wore there - display only. */
  username?: string;
  /** Whether that sign-in was an admin: "you host this" on the card. */
  isAdmin?: boolean;
  /** Last time this device listened from there (epoch ms). */
  lastUsed: number;
}

function read(): KnownServer[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as KnownServer[]) : [];
    return Array.isArray(list) ? list.filter((s) => typeof s?.url === 'string') : [];
  } catch {
    return [];
  }
}

function write(list: KnownServer[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage full or blocked: the ledger is a convenience, never a failure.
  }
}

/** Every server this device has entered, most recently used first. */
export function knownServers(): KnownServer[] {
  return [...read()].sort((a, b) => b.lastUsed - a.lastUsed);
}

/** Record (or refresh) a server after a successful sign-in. Fields merge, so
 *  a later caller that knows the name does not erase the role an earlier one
 *  knew. */
export function rememberServer(entry: Omit<KnownServer, 'lastUsed'> & { lastUsed?: number }) {
  const url = entry.url.replace(/\/+$/, '');
  const list = read();
  const prior = list.find((s) => s.url === url);
  const merged: KnownServer = {
    ...prior,
    ...entry,
    url,
    lastUsed: entry.lastUsed ?? Date.now(),
  };
  write([merged, ...list.filter((s) => s.url !== url)]);
}

/** Drop a server from the ledger - the card's own dismiss. Membership on the
 *  server itself is untouched; this only forgets the shortcut. */
export function forgetServer(url: string) {
  const clean = url.replace(/\/+$/, '');
  write(read().filter((s) => s.url !== clean));
}
