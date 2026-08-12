//! The household: more than one person on one device.
//!
//! A hub in a house has several accounts on it, and a phone or a kitchen
//! desktop gets handed between them. Signing out and back in loses the point
//! of separate accounts - each person's plays, resume positions, mixes and
//! stats are already kept apart server-side, and typing a password to reach
//! them is friction where a tap should do.
//!
//! So a device remembers the sessions it has been given, one per account, and
//! switching is instant. This is a CONVENIENCE over the existing sign-in, not
//! a new kind of trust: every stored session is one that was minted here by
//! someone who knew that account's password (or scanned its pairing code), and
//! signing a profile out forgets it entirely.

import type { ServerSession } from './server.ts';

const KEY = 'attackfm-household';

/** One remembered account on this device, newest use first. */
export interface Profile {
  session: ServerSession;
  /** When this profile was last switched to, for the ordering. */
  usedAt: number;
}

function read(): Profile[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is Profile =>
        !!p &&
        typeof (p as Profile).usedAt === 'number' &&
        typeof (p as Profile).session?.token === 'string' &&
        typeof (p as Profile).session?.url === 'string',
    );
  } catch {
    return [];
  }
}

function write(all: Profile[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // Applies for this run regardless; it just will not survive a relaunch.
  }
}

/** Everyone this device knows, most recently used first. */
export function profiles(): Profile[] {
  return read().sort((a, b) => b.usedAt - a.usedAt);
}

/** One identity per (server, username): a second sign-in as the same person
 *  replaces the first rather than stacking. */
function sameAs(a: ServerSession, b: ServerSession): boolean {
  return a.url === b.url && a.username === b.username;
}

/** Remember (or refresh) a profile - called on every sign-in and switch. */
export function rememberProfile(session: ServerSession): void {
  const rest = read().filter((p) => !sameAs(p.session, session));
  write([...rest, { session, usedAt: Date.now() }]);
}

/** Forget one. The session itself is not revoked server-side: this device
 *  simply stops holding it, which is what "not my phone any more" means. */
export function forgetProfile(session: ServerSession): void {
  write(read().filter((p) => !sameAs(p.session, session)));
}

/** The others - who this device could switch to right now. */
export function otherProfiles(current: ServerSession | null): Profile[] {
  return profiles().filter((p) => !current || !sameAs(p.session, current));
}
