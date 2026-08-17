//! Keeping the account's list of servers in step with this device's.
//!
//! A phone that has signed into a hub and linked a mirror knows two addresses
//! that no other device does. This pushes them to the registry account, so the
//! next device - a new phone, a reinstall, the desktop - is handed the same
//! list instead of being asked to remember hostnames.
//!
//! WHAT TRAVELS IS ADDRESSES, NOT SESSIONS. Every device mints its own tokens
//! by re-proving membership through `/api/registry/enter`; the account stores
//! only "you can reach this box". That is a deliberate refusal rather than an
//! omission: syncing the tokens would turn one registry row into a master key
//! for every music server the account touches, and a directory breach would
//! hand over all of them at once. Addresses leak a list of hostnames.
//!
//! Everything here is best-effort. The registry being unreachable must never
//! be something a listener finds out about - the device already has what it
//! needs to play.

import { fetchMemberships, forgetMembership, recordMembership, type Membership } from './registry.ts';
import { mirrorList, subscribeMirrors } from './mirrors.ts';
import { knownServers, subscribeKnownServers } from './servers.ts';
import type { ServerSession } from '../server.ts';

const REGISTRY_KEY = 'attackfm-registry-session';
/** What this device last managed to push, so a removal can be noticed. */
const PUSHED_KEY = 'attackfm-synced-servers';

/** The registry token, read straight from storage - this module runs outside
 *  React and must not need a provider to do its quiet work. */
function registryToken(): string | null {
  try {
    const raw = localStorage.getItem(REGISTRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { token?: string };
    return parsed?.token ?? null;
  } catch {
    return null;
  }
}

function lastPushed(): string[] {
  try {
    const raw = localStorage.getItem(PUSHED_KEY);
    const list = raw ? (JSON.parse(raw) as string[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberPushed(urls: string[]): void {
  try {
    localStorage.setItem(PUSHED_KEY, JSON.stringify(urls));
  } catch {
    // The next pass will simply push the same list again.
  }
}

/** Everything this device knows: the session server, each linked mirror, and
 *  every server remembered on a card. The ledger matters most - a phone that
 *  has signed into three servers holds two of them ONLY there, and those two
 *  were exactly the ones the account never learned about. */
function localServers(session: ServerSession | null): { serverUrl: string; serverName: string; role: string }[] {
  const out: { serverUrl: string; serverName: string; role: string }[] = [];
  const add = (serverUrl: string, serverName: string, role: string) => {
    const url = serverUrl.replace(/\/+$/, '');
    if (!url || out.some((s) => s.serverUrl === url)) return;
    out.push({ serverUrl: url, serverName, role });
  };
  if (session) add(session.url, '', session.isAdmin ? 'owner' : 'member');
  for (const m of mirrorList()) add(m.url, m.name ?? '', m.isAdmin ? 'owner' : 'member');
  for (const k of knownServers()) add(k.url, k.name ?? '', k.isAdmin ? 'owner' : 'member');
  return out;
}

/**
 * Push this device's servers to the account.
 *
 * Additive only. An earlier version diffed against what this device last
 * pushed and RETRACTED the difference - which, because the push set was only
 * "session + mirrors", meant switching servers quietly deleted the previous
 * one from the account. Removal is an intention, not a side effect: it
 * happens in {@link forgetServerEverywhere}, when someone dismisses the card.
 */
export async function syncServersUp(session: ServerSession | null): Promise<void> {
  const token = registryToken();
  if (!token) return;
  const mine = localServers(session);
  await Promise.all(mine.map((s) => recordMembership(token, s).catch(() => {})));
  rememberPushed(mine.map((s) => s.serverUrl));
}

/** The one deliberate removal: drop a server from this device AND the
 *  account, so it stops being offered back to every new phone. */
export async function forgetServerEverywhere(serverUrl: string): Promise<void> {
  const token = registryToken();
  if (!token) return;
  await forgetMembership(token, serverUrl.replace(/\/+$/, '')).catch(() => {});
}

/** Every server saved to the account, from any device. Empty when signed out
 *  of the registry or when it cannot be reached. */
export async function fetchSavedServers(): Promise<Membership[]> {
  const token = registryToken();
  if (!token) return [];
  try {
    return await fetchMemberships(token);
  } catch {
    return [];
  }
}

/**
 * Keep the account in step for as long as a session is live.
 *
 * Pushes once on start, then whenever the mirror ledger changes. There is no
 * timer: the list only moves when someone links or unlinks a server, and those
 * are the two moments this fires. Returns its own cleanup.
 */
export function startServerSync(session: ServerSession | null): () => void {
  let stopped = false;
  const push = () => {
    if (stopped) return;
    void syncServersUp(session);
  };
  push();
  const offMirrors = subscribeMirrors(push);
  const offKnown = subscribeKnownServers(push);
  return () => {
    stopped = true;
    offMirrors();
    offKnown();
  };
}
