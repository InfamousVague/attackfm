//! The news, kept where a bell can count it.
//!
//! Downloads used to announce themselves by shoving a pill over whatever you
//! were looking at, once, and then forgetting. Miss the three seconds and the
//! only trace an import ever landed was the library quietly being bigger. That
//! is the wrong shape for the event: a download finishes minutes later, from a
//! background poll, while you are reading an artist page - so it is news you
//! may be anywhere for, and news you may want to read afterwards.
//!
//! This is the other half. A small ring of what happened, kept on the device,
//! counted on a bell, read when you choose to read it.
//!
//! It follows diagLog's three rules for the same reasons - it PERSISTS (the
//! interesting arrivals happen while the app is backgrounded), it is BOUNDED
//! in entries and characters, and it is TOLERANT of its own older shapes - and
//! adds a fourth of its own: it is SCOPED. Signing in as somebody else must not
//! show you their week.
//!
//! Device-local on purpose. The server records that it sent a push but not what
//! the push said (`push_sent` carries no title or body), so there is nothing to
//! sync down even if we wanted to. The day there is an `/api/notices`, this
//! becomes the local mirror in front of it.

import { useCallback, useSyncExternalStore } from 'react';
import { mirrorNoticeToOs } from './osNotify.ts';

const KEY_BASE = 'attackfm-notify-v1';
/** A month of ordinary use for somebody who imports most days, and small
 *  enough that the whole ring stays a cheap synchronous read at boot. */
const MAX_NOTICES = 50;
/** No single line may run away with the ring - a server error page pasted into
 *  a body would otherwise cost kilobytes per failure. */
const MAX_TEXT = 160;

export interface Notice {
  /**
   * Stable and caller-supplied (`import:<jobId>`), because the queue is read by
   * a POLL: the same finished job is seen again on every tick, and an id is
   * what stops one landing becoming forty rows.
   */
  id: string;
  /** Epoch ms. */
  at: number;
  /**
   * One of the server's push kinds (drops, curated, dates, digest, recap,
   * friends) so one word governs both the OS alert and the in-app row, plus
   * the local-only kinds this centre raises on its own. An unknown kind still
   * renders - see `kinds.ts`.
   */
  kind: string;
  title: string;
  body: string;
  /** Cover for the row, already an app URL. Null draws the kind's glyph. */
  art: string | null;
  /** Where a press lands, or null for a line of news with nowhere to go. */
  door: 'downloads' | null;
  read: boolean;
}

/** What `noteNotice` is given: the row, minus the bookkeeping it does itself. */
export type NewNotice = Omit<Notice, 'read' | 'at'> & { at?: number };

let scopeKey: string | null = null;
let entries: Notice[] = load();
const listeners = new Set<() => void>();

/**
 * The empty ring, as one frozen array.
 *
 * `useSyncExternalStore` compares snapshots by identity and re-renders when
 * they differ, so a getter that builds a fresh `[]` each call re-renders
 * forever. Every path that means "nothing" returns THIS array.
 */
const EMPTY: readonly Notice[] = Object.freeze([]);

/**
 * Derived values, computed once per mutation rather than per read.
 *
 * Same trap as above, one step further along: `unreadKinds()` returns a Set,
 * and a Set built inside the getter is a new object every time React looks -
 * which is an infinite render loop rather than a slow one. These are recomputed
 * in `changed()` and handed out by reference until the next mutation.
 */
let unreadTally = 0;
let unreadKindSet: ReadonlySet<string> = new Set();

function storageKey(): string {
  return scopeKey ? `${KEY_BASE}:${scopeKey}` : KEY_BASE;
}

function load(): Notice[] {
  try {
    const raw = localStorage.getItem(storageKey());
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Written by an older shape, or hand-edited: take only what still reads,
    // and fill the rest so a row from a past version cannot crash a render.
    return parsed
      .filter((e): e is Notice => !!e && typeof e === 'object' && typeof (e as Notice).id === 'string')
      .map((e) => ({
        id: e.id,
        at: typeof e.at === 'number' ? e.at : Date.now(),
        kind: typeof e.kind === 'string' ? e.kind : 'drops',
        title: typeof e.title === 'string' ? e.title : '',
        body: typeof e.body === 'string' ? e.body : '',
        art: typeof e.art === 'string' ? e.art : null,
        door: e.door === 'downloads' ? 'downloads' : null,
        read: e.read === true,
      }));
  } catch {
    return [];
  }
}

/** Recompute what the bell reads, then wake everyone watching. */
function changed(): void {
  unreadTally = 0;
  const kinds = new Set<string>();
  for (const n of entries) {
    if (n.read) continue;
    unreadTally += 1;
    kinds.add(n.kind);
  }
  unreadKindSet = kinds;
  persist();
  for (const cb of listeners) cb();
}

/**
 * Write the ring out, at most every couple of seconds.
 *
 * A notice is a human-paced event rather than a heartbeat, so the debounce is
 * not load-bearing the way diagLog's is - but it costs nothing, and a burst of
 * forty landings arriving on one poll tick is exactly the case where writing
 * per entry would be forty synchronous stringifies on the main thread.
 */
const PERSIST_EVERY_MS = 2000;
let persistTimer: number | null = null;

function writeNow(): void {
  persistTimer = null;
  try {
    localStorage.setItem(storageKey(), JSON.stringify(entries));
  } catch {
    // A full or disabled store is not worth failing anything over; the
    // in-memory ring still serves the panel for this run.
  }
}

function persist(): void {
  if (persistTimer !== null) return;
  if (typeof window === 'undefined') return writeNow();
  persistTimer = window.setTimeout(writeNow, PERSIST_EVERY_MS);
}

/** Write immediately, losing nothing when the app is killed or backgrounded -
 *  which on a phone is most of the time, and is precisely when the arrivals
 *  worth reading were recorded. */
export function flushNotices(): void {
  if (persistTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(persistTimer);
  }
  writeNow();
}

/**
 * Point the ring at one account's news.
 *
 * Called with the signed-in identity, and with null when there is none. The
 * flush before the swap matters: the debounce means the previous account's
 * last few rows may still be only in memory, and switching without writing
 * them would drop them on the floor.
 */
export function setNoticeScope(key: string | null): void {
  if (key === scopeKey) return;
  flushNotices();
  scopeKey = key;
  entries = load();
  changed();
}

/**
 * Add a row, or update the one already standing for this id.
 *
 * Replacing IN PLACE rather than appending is what makes a polled queue safe to
 * report from: the same job seen again is the same row, not a second one. The
 * `read` flag is carried across deliberately - a re-report of something you
 * have already seen must not make the bell claim it is new again.
 */
export function noteNotice(n: NewNotice): void {
  const row: Notice = {
    id: n.id,
    at: n.at ?? Date.now(),
    kind: n.kind,
    title: clamp(n.title),
    body: clamp(n.body),
    art: n.art,
    door: n.door,
    read: false,
  };

  const at = entries.findIndex((e) => e.id === n.id);
  if (at >= 0) {
    /*
     * SAME ID, BUT IS IT THE SAME NEWS? The kind is what answers that, and
     * getting it wrong is silent.
     *
     * An import keeps its job id across a retry, so a download that fails and
     * later succeeds reports twice under one id. Carrying `read` across
     * unconditionally meant the failure you had already looked at stamped the
     * SUCCESS as read: the bell buzzed, the badge stayed dark, no row moved,
     * and the arrival you were waiting for was announced to nobody.
     *
     * So: same kind is the same story being restated (a failure re-reported by
     * the next poll) and keeps both its read flag and its place. A DIFFERENT
     * kind is a new event that happens to share an id, and is treated as one -
     * unread, and moved to the end so the newest-first panel puts it on top,
     * where its own timestamp now belongs.
     */
    const prev = entries[at]!;
    const sameNews = prev.kind === row.kind;
    row.read = sameNews ? prev.read : false;
    entries = sameNews
      ? entries.map((e, i) => (i === at ? row : e))
      : [...entries.slice(0, at), ...entries.slice(at + 1), row];
    // A restated story has already been announced; only the new event rings.
    // This is the same `sameNews` question the read flag turns on, which is why
    // it is answered once, here, rather than guessed at again in the tray.
    if (!sameNews) mirrorNoticeToOs(row);
  } else {
    entries = [...entries, row];
    if (entries.length > MAX_NOTICES) entries = entries.slice(-MAX_NOTICES);
    mirrorNoticeToOs(row);
  }
  changed();
}

/**
 * A timestamp from anywhere, in milliseconds.
 *
 * The import queue reports `created_at` in unix SECONDS (the server builds it
 * from `duration_since(UNIX_EPOCH).as_secs()`), while everything on this side
 * of the wire thinks in `Date.now()` milliseconds. Mixing the two does not
 * throw and does not look wrong in a debugger - it silently makes every
 * comparison against a duration false, which is exactly how the freshness test
 * here came to be dead code that swallowed real arrivals.
 *
 * Decoded in ONE place so there is one thing to get right. 1e12 ms is 2001, so
 * anything below it cannot be a millisecond timestamp for a running app.
 */
export function msOf(at: number): number {
  return at < 1e12 ? at * 1000 : at;
}

function clamp(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/** Oldest first. The panel reverses it; the ring itself stays in arrival order
 *  so the slice that drops the eldest is the cheap one. */
export function notices(): readonly Notice[] {
  return entries.length === 0 ? EMPTY : entries;
}

export function unreadCount(): number {
  return unreadTally;
}

export function unreadKinds(): ReadonlySet<string> {
  return unreadKindSet;
}

/** Everything read. Opening the panel is being told, so the count clears then -
 *  a badge that survives being looked at is a badge nobody trusts. */
export function markAllRead(): void {
  if (unreadTally === 0) return;
  entries = entries.map((e) => (e.read ? e : { ...e, read: true }));
  changed();
  // Straight through: being read is a deliberate act and must survive a kill
  // in the next two seconds, or the badge comes back from the dead.
  flushNotices();
}

/**
 * One notice, gone.
 *
 * The panel only ever had "clear everything", which is a poor answer to a
 * single stuck row: a failed download that will not go away is exactly the
 * notice somebody wants rid of WITHOUT throwing away the other five they have
 * not read yet. Dismissing is about the list, not about the thing it reports -
 * the download is still failed, it is simply no longer being announced.
 *
 * The unread tally is recounted rather than decremented, because a notice may
 * or may not have been read and guessing which is how a badge starts lying.
 */
export function dismissNotice(id: string): void {
  const next = entries.filter((e) => e.id !== id);
  if (next.length === entries.length) return;
  entries = next;
  changed();
  flushNotices();
}

export function clearNotices(): void {
  if (entries.length === 0) return;
  entries = [];
  changed();
  flushNotices();
}

export function subscribeNotices(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// --- hooks ------------------------------------------------------------------

export function useNotices(): readonly Notice[] {
  return useSyncExternalStore(subscribeNotices, notices, getEmpty);
}

export function useUnreadNotices(): number {
  return useSyncExternalStore(subscribeNotices, unreadCount, getZero);
}

export function useUnreadKinds(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeNotices, unreadKinds, getNoKinds);
}

// Server snapshots. Stable references, for the same identity reason as EMPTY.
const NO_KINDS: ReadonlySet<string> = new Set();
function getEmpty(): readonly Notice[] {
  return EMPTY;
}
function getZero(): number {
  return 0;
}
function getNoKinds(): ReadonlySet<string> {
  return NO_KINDS;
}

// The debounced write's safety net, the same pair diagLog installs: `pagehide`
// and a hidden `visibilitychange` are the only events a mobile webview reliably
// gets before it is frozen or killed - `beforeunload` is not delivered on iOS.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushNotices);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushNotices();
  });
}

// The load above ran before `changed()` ever did, so the derived counts start
// at zero while the ring may already hold unread rows from the last run.
changed();
