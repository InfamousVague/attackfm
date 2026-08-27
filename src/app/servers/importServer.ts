/**
 * Which server actually runs an import.
 *
 * The app has always assumed the box you are signed into is the box that can
 * download - the importer plugin asked `useServerSession()` and posted there.
 * That is one machine too few. The downloader (SpotiFLAC and everything it
 * drags in) is installed on ONE server; the library usually lives on another,
 * bigger, nearer one. Hard-wiring imports to the session server means either
 * the hub cannot import at all, or you have to sign out of your library to use
 * the downloader.
 *
 * So this is the one place that answers "which server runs an import", and the
 * importer asks it instead of assuming. The peer downloads, and its own
 * peer-sync copies the finished files across to the hub, so both end up
 * holding the song and `mirrors.ts` keeps routing playback to whichever is
 * nearer. Nothing here touches playback routing - that question already has a
 * good answer.
 *
 * ONE KNOWN COST, accepted rather than fixed here. A finished job reports
 * `trackIds` that are row ids on the server that RAN it, and `useFilePlan`
 * joins those against the session server's rows to file a download into the
 * playlist it was asked for. Point imports at another box and that join is
 * against ids from a different database: usually it simply finds nothing and
 * the plan sits waiting, and in the unlucky case two servers used the same
 * number for different songs it files the wrong one. Filing an import
 * straight into a playlist is the only surface affected - the songs
 * themselves arrive, sync across, and play. Fixing it means joining on
 * `trackKey(artist, title)` the way mirrors already do, which is a change to
 * the plan, not to the choice, and belongs with that code.
 */

import { useMemo, useSyncExternalStore } from 'react';
import type { ServerSession } from '../server.ts';
import { healthOf, mirrorList, subscribeMirrors } from './mirrors.ts';
import { allSessions, normalise, subscribeSessions } from './sessions.ts';
import { useServerSession } from './serverSession.tsx';

/**
 * A URL, never credentials. Tokens for every server this device knows already
 * live in `attackfm-mirrors` and `attackfm-sessions`; a third copy here would
 * be a third thing to revoke and a third thing to leak, and it would go stale
 * the moment either of those refreshed.
 */
const KEY = 'attackfm-import-server';

export interface ImportTarget {
  url: string;
  label: string;
  /** The server this device is signed into - the default, and the fallback. */
  primary: boolean;
  /** The one imports currently run on. */
  chosen: boolean;
}

// --- the store --------------------------------------------------------------

const listeners = new Set<() => void>();

function read(): string | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? raw : null;
  } catch {
    return null;
  }
}

let chosen: string | null = typeof localStorage === 'undefined' ? null : read();

/**
 * A version counter rather than the value itself.
 *
 * `useSyncExternalStore` compares snapshots with Object.is, so a hook that
 * wants the resolved SESSION (a fresh object every time) cannot use one as its
 * snapshot without re-rendering forever. A number moves only when something
 * genuinely changed, and the hooks below derive from it.
 */
let version = 0;

function bump(): void {
  version += 1;
  for (const l of listeners) l();
}

function snapshot(): number {
  return version;
}

export function importServerUrl(): string | null {
  return chosen;
}

/** `null` means "follow the session server", which is also the default. */
export function setImportServerUrl(url: string | null): void {
  chosen = url;
  try {
    if (url) localStorage.setItem(KEY, url);
    else localStorage.removeItem(KEY);
  } catch {
    // Applies for this run; it just will not survive a relaunch.
  }
  bump();
}

/**
 * Changes to the CHOICE, and to either credential store it resolves against.
 *
 * Forgetting a mirror or signing out of a server changes which import server
 * exists without touching the choice itself, and a picker that did not hear
 * about that would keep offering - and the provider keep polling - a box this
 * device no longer holds a token for.
 */
export function subscribeImportServer(cb: () => void): () => void {
  listeners.add(cb);
  /*
   * Move the counter, THEN notify.
   *
   * `snapshot()` returns `version`, and useSyncExternalStore compares the new
   * snapshot with Object.is before it re-renders. Handing `cb` straight to the
   * two credential stores fires the callback with `version` unchanged, so React
   * re-reads the same integer and bails - and the staleness this subscription
   * exists to prevent happens anyway: the picker keeps offering a forgotten
   * mirror and the provider keeps polling it with a token this device no longer
   * holds. It self-corrected only on reload, which reads as a flaky picker.
   */
  const relay = () => {
    version += 1;
    cb();
  };
  const offMirrors = subscribeMirrors(relay);
  const offSessions = subscribeSessions(relay);
  return () => {
    listeners.delete(cb);
    offMirrors();
    offSessions();
  };
}

// --- resolving --------------------------------------------------------------

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** Every box this device could run an import on, session server first. */
export function importTargets(session: ServerSession | null): ImportTarget[] {
  const out: ImportTarget[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string, primary: boolean) => {
    const key = normalise(url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ url, label, primary, chosen: false });
  };
  if (session) add(session.url, hostOf(session.url), true);
  for (const m of mirrorList()) add(m.url, m.name ?? hostOf(m.url), false);
  for (const s of allSessions()) add(s.url, hostOf(s.url), false);

  // Mark the live one AFTER dedupe, so a server that is both the session and a
  // mirror is marked on the single row that survived rather than not at all.
  const active = resolveImportServer(session);
  if (active) {
    const key = normalise(active.url);
    for (const t of out) if (normalise(t.url) === key) t.chosen = true;
  }
  return out;
}

/**
 * The chosen server, as something the import calls can actually be given.
 *
 * Every `serverEnqueueImport`/`serverListImports`/... already takes a
 * `ServerSession`, so pointing the importer at another box is entirely a
 * question of which object it is handed - this function.
 *
 * The last line is the load-bearing one: a chosen server that no longer has
 * credentials on this device degrades to the session server, NEVER to null.
 * Returning null would stop every import dead with nothing on screen saying
 * why, which is the worst failure this feature can have - it looks exactly
 * like the importer being broken.
 */
/**
 * Every box this device could actually send an import to, credentials and all.
 */
function knownServers(session: ServerSession | null): ServerSession[] {
  const out: ServerSession[] = [];
  const seen = new Set<string>();
  const add = (s: ServerSession) => {
    const key = normalise(s.url);
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push(s);
  };
  if (session) add(session);
  for (const m of mirrorList()) {
    const { url, token, streamToken, username, isAdmin } = m;
    add({ url, token, streamToken, username, isAdmin });
  }
  for (const s of allSessions()) add(s);
  return out;
}

/**
 * Where imports go when nobody has chosen: the signed-in server, unless it has
 * SAID it cannot download and exactly one other box has said it can.
 *
 * The hub and the downloader are usually different machines, and the app knew
 * that and picked the hub anyway - so a pasted link went to the box with no
 * downloader, failed, and left the listener to discover a setting they had no
 * reason to look for. The servers now say which they are in `/api/server`, and
 * this believes them.
 *
 * Two restraints, both deliberate, and they are not symmetric.
 *
 * MOVING requires the signed-in box to have said `imports === false` outright.
 * An older server does not carry the field at all, and reading that silence as
 * "cannot download" would move imports off a box that has been fetching them
 * perfectly well.
 *
 * ARRIVING only requires a candidate not to have said no. Once the current box
 * has explicitly refused, leaving the import there is certain to fail, so an
 * unknown box is strictly the better bet - and it is the ordinary case while a
 * second server is still a version behind and not yet advertising.
 *
 * And EXACTLY one candidate either way: with two there is no answer that is not
 * a guess about which library the music should land in, and guessing that
 * silently is how songs end up somewhere nobody looks.
 */
function automaticTarget(session: ServerSession | null): ServerSession | null {
  if (!session) return null;
  if (healthOf(session.url)?.imports !== false) return session;
  const able = knownServers(session).filter(
    (s) => normalise(s.url) !== normalise(session.url) && healthOf(s.url)?.imports !== false,
  );
  return able.length === 1 ? able[0]! : session;
}

/** True when the target was worked out rather than chosen, so the picker can
 *  say so instead of looking like somebody set it. */
export function importServerIsAutomatic(session: ServerSession | null): boolean {
  if (chosen || !session) return false;
  const auto = automaticTarget(session);
  return !!auto && normalise(auto.url) !== normalise(session.url);
}

export function resolveImportServer(session: ServerSession | null): ServerSession | null {
  if (!chosen) return automaticTarget(session);
  const key = normalise(chosen);
  if (session && normalise(session.url) === key) return session;

  // A Mirror is structurally a superset of a ServerSession (url, token,
  // streamToken, username, isAdmin), which is the same assumption pickSource
  // already makes when it hands one to syncLibrary.
  const mirror = mirrorList().find((m) => normalise(m.url) === key);
  if (mirror) {
    const { url, token, streamToken, username, isAdmin } = mirror;
    return { url, token, streamToken, username, isAdmin };
  }

  const other = allSessions().find((s) => normalise(s.url) === key);
  if (other) return other;

  return session;
}

/**
 * A choice this device cannot honour, or null when it is being honoured.
 *
 * `resolveImportServer` degrades to the session server when the chosen box has
 * no credentials here, and that is the right call - returning null would stop
 * every import dead. But it is SILENT, and silence is indistinguishable from
 * the pin never having been set: every import runs on the hub, the picker
 * shows the hub, and nothing anywhere says a choice was made and dropped.
 *
 * That is not a hypothetical. Sign out of the peer, forget its mirror, or
 * restore this device from a backup that carried the CHOICE (localStorage)
 * without the CREDENTIALS (a different key), and imports move box without a
 * word. The fallback stays; what changes is that the picker can now say it is
 * happening.
 */
export function orphanedImportChoice(session: ServerSession | null): string | null {
  if (!chosen) return null;
  const resolved = resolveImportServer(session);
  if (resolved && normalise(resolved.url) === normalise(chosen)) return null;
  return chosen;
}

export function useOrphanedImportChoice(): string | null {
  const { session } = useServerSession();
  const v = useSyncExternalStore(subscribeImportServer, snapshot, snapshot);
  return useMemo(() => orphanedImportChoice(session), [session, v]);
}

export function useImportServer(): ServerSession | null {
  const { session } = useServerSession();
  const v = useSyncExternalStore(subscribeImportServer, snapshot, snapshot);
  return useMemo(() => resolveImportServer(session), [session, v]);
}

export function useImportTargets(): ImportTarget[] {
  const { session } = useServerSession();
  const v = useSyncExternalStore(subscribeImportServer, snapshot, snapshot);
  return useMemo(() => importTargets(session), [session, v]);
}

// --- the loud failure -------------------------------------------------------

export interface ImportServerFault {
  url: string;
  reason: string;
  at: number;
}

let fault: ImportServerFault | null = null;

/**
 * The chosen server answered, and said no.
 *
 * Deliberately NOT a reroute. There are two ways a chosen import server can be
 * wrong and they need opposite handling: one that has been forgotten has no
 * credentials at all, so falling back silently is the only thing possible; one
 * that is present but rejecting our token is a box the user picked ON PURPOSE
 * because it is the only one with the downloader. Quietly moving those imports
 * to the hub would run them on a machine that cannot download, and the user
 * would get an unexplainable failure from a server they never chose. So this
 * records the fault, the picker says it out loud, and moving is one tap the
 * person takes.
 */
export function noteImportServerRejected(url: string, reason: string): void {
  fault = { url, reason, at: Date.now() };
  bump();
}

export function clearImportServerFault(): void {
  if (!fault) return;
  fault = null;
  bump();
}

export function importServerFault(): ImportServerFault | null {
  return fault;
}

export { hostOf as importServerHost };
