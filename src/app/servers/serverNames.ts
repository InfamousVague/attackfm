import { useSyncExternalStore } from 'react';
import { fetchServerInfo } from '../api/auth.ts';
import { knownServers } from './servers.ts';
import { mirrorList } from './mirrors.ts';
import { allSessions, normalise, primarySession, sessionsSnapshot, subscribeSessions } from './sessions.ts';
import type { ServerSession } from '../server.ts';

/**
 * What to call a server in front of a person - "Kevin's server".
 *
 * A hub's name lived in four disconnected places (the session set carries
 * none of them), and "Kevin's" was minted as a string in exactly one spot,
 * for invites. This is the one resolver: a learned map of url -> {owner,
 * name}, fed by every /api/server the app already reads (the reachability
 * probe, the sign-in info fetch, the secondary-library sync), and falling
 * back through the known-servers and mirrors ledgers to the bare host.
 *
 * The owner wins over the box's own name: "Matt's server" is what a friend
 * recognises; "AttackFM (home)" is what the box calls itself.
 */

const KEY = 'attackfm-server-names';

interface Learned {
  name?: string;
  owner?: string;
}

function read(): Record<string, Learned> {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Learned>) : {};
  } catch {
    return {};
  }
}

let learned: Record<string, Learned> = typeof localStorage === 'undefined' ? {} : read();
const listeners = new Set<() => void>();
let version = 0;

export function rememberServerName(url: string, info: Learned): void {
  const key = normalise(url);
  const prior = learned[key] ?? {};
  const next: Learned = { ...prior };
  if (info.name?.trim()) next.name = info.name.trim();
  if (info.owner?.trim()) next.owner = info.owner.trim();
  if (next.name === prior.name && next.owner === prior.owner) return;
  learned = { ...learned, [key]: next };
  version += 1;
  try {
    localStorage.setItem(KEY, JSON.stringify(learned));
  } catch {
    // Names are a convenience; losing them costs a host in place of a name.
  }
  for (const l of listeners) l();
}

/** Possessive, the way the invite card spells it. */
function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

/**
 * The label for a server url. `null` for an unknown url, so a caller can
 * decide between hiding and showing the host.
 */
export function serverLabelFor(url: string | null | undefined): string | null {
  if (!url) return null;
  const key = normalise(url);
  const l = learned[key];
  if (l?.owner) return `${possessive(l.owner)} server`;
  if (l?.name) return l.name;
  const known = knownServers().find((s) => normalise(s.url) === key);
  if (known?.name) return known.name;
  const mirror = mirrorList().find((m) => normalise(m.url) === key);
  if (mirror?.name) return mirror.name;
  return hostOf(url);
}

/**
 * Learn a server's name and owner from its own /api/server. Once per url per
 * launch - the answer does not change under a running app, and the probe
 * keeps it fresh anyway.
 */
const asked = new Set<string>();
export function learnServerName(session: ServerSession): void {
  const key = normalise(session.url);
  if (asked.has(key)) return;
  asked.add(key);
  void fetchServerInfo(session.url)
    .then((info) => {
      const owner = (info as { owner?: string }).owner;
      rememberServerName(session.url, { name: info.name, owner });
    })
    .catch(() => {
      asked.delete(key);
    });
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  const off = subscribeSessions(cb);
  return () => {
    listeners.delete(cb);
    off();
  };
}
function snapshot(): number {
  return version * 1000 + Object.keys(sessionsSnapshot().byUrl).length;
}

/**
 * A labeller for song rows: given a path, the server it belongs to - or null
 * when there is only one server, because "on Matt's server" under every row
 * of a single-hub library is noise, not information. Re-renders the caller
 * when a name is learned or a server is added.
 */
export function useOriginLabeler(): (origin: string | null | undefined) => string | null {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const many = allSessions().length > 1;
  const primary = primarySession();
  return (origin) => {
    if (!many) return null;
    const url = origin ?? primary?.url ?? null;
    const label = serverLabelFor(url);
    return label ? `on ${label}` : null;
  };
}
