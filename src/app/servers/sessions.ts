import type { ServerSession } from '../server.ts';

/**
 * Every server this device is signed in to, not just the current one.
 *
 * The app has always held exactly one session. Switching servers meant signing
 * out of one and into the next, which is why "join another server" felt like
 * leaving rather than adding: a library you were a member of was invisible
 * until you went back to it.
 *
 * This keeps them all. One is PRIMARY - the one whose home screen you see, and
 * the one a path with no origin belongs to - and the rest stay live so their
 * songs can appear in a search and play without a round of re-authentication.
 *
 * Kept beside the existing single-session storage rather than replacing it: an
 * install that has never seen this still reads `attackfm-server-session` and
 * works exactly as before, and the first sign-in through the new path seeds
 * both. Nothing is migrated until it has to be.
 */

const KEY = 'attackfm-sessions';

export interface SessionSet {
  /** Sessions by server URL, normalised without a trailing slash. */
  byUrl: Record<string, ServerSession>;
  /** Which one the app is "on". Always a key of byUrl, or '' when empty. */
  primary: string;
}

const EMPTY: SessionSet = { byUrl: {}, primary: '' };

/** Trailing slash and case are not part of a server's identity. */
export function normalise(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

export function readSessions(): SessionSet {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<SessionSet>;
    const byUrl = parsed.byUrl ?? {};
    const primary = parsed.primary ?? '';
    // A primary that names a session we do not hold would leave the app
    // pointing at nothing; fall back to any session rather than none.
    const valid = primary && byUrl[primary] ? primary : (Object.keys(byUrl)[0] ?? '');
    return { byUrl, primary: valid };
  } catch {
    return EMPTY;
  }
}

const listeners = new Set<() => void>();
let snapshot: SessionSet = typeof localStorage === 'undefined' ? EMPTY : readSessions();

function commit(next: SessionSet): void {
  snapshot = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Applies for this run; it just will not survive a relaunch.
  }
  for (const l of listeners) l();
}

/** Add or replace a server's session, making it primary unless told otherwise. */
export function rememberSession(session: ServerSession, makePrimary = true): void {
  const url = normalise(session.url);
  const byUrl = { ...snapshot.byUrl, [url]: { ...session, url: session.url } };
  commit({ byUrl, primary: makePrimary || !snapshot.primary ? url : snapshot.primary });
}

/** Sign out of one server, leaving the others alone. */
export function forgetSession(url: string): void {
  const key = normalise(url);
  const byUrl = { ...snapshot.byUrl };
  delete byUrl[key];
  const primary = snapshot.primary === key ? (Object.keys(byUrl)[0] ?? '') : snapshot.primary;
  commit({ byUrl, primary });
}

export function setPrimary(url: string): void {
  const key = normalise(url);
  if (!snapshot.byUrl[key]) return;
  commit({ ...snapshot, primary: key });
}

export function allSessions(): ServerSession[] {
  return Object.values(snapshot.byUrl);
}

export function primarySession(): ServerSession | null {
  return snapshot.byUrl[snapshot.primary] ?? null;
}

/**
 * The session that owns a path, by the origin encoded in it.
 *
 * Falls back to the primary, which is what makes every path written before
 * multi-server existed keep working: they name no origin, and they came from
 * whichever server was current at the time.
 */
export function sessionForOrigin(origin: string | null | undefined): ServerSession | null {
  if (!origin) return primarySession();
  return snapshot.byUrl[normalise(origin)] ?? primarySession();
}

export function subscribeSessions(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function sessionsSnapshot(): SessionSet {
  return snapshot;
}
