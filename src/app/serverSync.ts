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
import type { ServerSession } from './server.ts';

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

/** Everything this device can currently reach: the session server first, then
 *  each linked mirror. */
function localServers(session: ServerSession | null): { serverUrl: string; serverName: string; role: string }[] {
  const out: { serverUrl: string; serverName: string; role: string }[] = [];
  if (session) {
    out.push({
      serverUrl: session.url,
      serverName: '',
      role: session.isAdmin ? 'owner' : 'member',
    });
  }
  for (const m of mirrorList()) {
    if (out.some((s) => s.serverUrl === m.url)) continue;
    out.push({ serverUrl: m.url, serverName: m.name ?? '', role: m.isAdmin ? 'owner' : 'member' });
  }
  return out;
}

/**
 * Push this device's servers to the account, and retract what it dropped.
 *
 * The retraction half matters: the list is pushed per-entry rather than as a
 * whole, so a server unlinked here would otherwise live on in the account
 * forever and keep being offered back to every new device.
 */
export async function syncServersUp(session: ServerSession | null): Promise<void> {
  const token = registryToken();
  if (!token) return;
  const mine = localServers(session);
  const urls = mine.map((s) => s.serverUrl);
  const gone = lastPushed().filter((u) => !urls.includes(u));

  await Promise.all([
    ...mine.map((s) => recordMembership(token, s).catch(() => {})),
    ...gone.map((u) => forgetMembership(token, u).catch(() => {})),
  ]);
  rememberPushed(urls);
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
  const off = subscribeMirrors(push);
  return () => {
    stopped = true;
    off();
  };
}
