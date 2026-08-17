import { useCallback, useEffect, useRef, useState } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  clearRecents,
  fetchRecents,
  removeRecent,
  touchRecent,
  type Recent,
} from '../server.ts';

/**
 * What you opened from search last time - the row the page shows before you
 * have typed anything.
 *
 * It follows the account when there is one: the server keeps the list, so a
 * song looked up on the phone is at the front of the row on the desktop. With
 * no server (a purely local library) the same list lives in this device's
 * storage instead, which is the only place it could live. Both halves wear the
 * same interface, so nothing above here knows which one it got.
 *
 * Every edit is optimistic. A recent is a convenience, and a convenience that
 * waits on a round trip before the tile moves is worse than one that is
 * occasionally a beat ahead of the truth; a failed write just leaves this
 * device's copy right and the next load reconciles it.
 */

export type { Recent } from '../server.ts';

/** Where this device's mirror lives. Keyed per account when there is one, so
 *  signing in as somebody else does not flash their predecessor's shortcuts. */
function localKey(session: { url: string; username: string } | null): string {
  return session ? `attackfm-search-recents:${session.url}:${session.username}` : 'attackfm-search-recents';
}

/** How many are kept. Past this the row is a history, not a shortcut. */
const CAP = 20;

export interface SearchRecents {
  items: Recent[];
  /** Remember it, or bump it to the front if it is already remembered. */
  touch: (recent: Omit<Recent, 'at'>) => void;
  remove: (kind: string, key: string) => void;
  clear: () => void;
}

function readLocal(session: { url: string; username: string } | null): Recent[] {
  try {
    const raw = localStorage.getItem(localKey(session));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as Recent[]) : [];
  } catch {
    return [];
  }
}

function writeLocal(
  session: { url: string; username: string } | null,
  items: readonly Recent[],
): void {
  try {
    localStorage.setItem(localKey(session), JSON.stringify(items));
  } catch {
    // A full or disabled store costs the shortcut, not the search.
  }
}

/** The list with `recent` at its front and any older copy of it dropped. */
function withFront(items: readonly Recent[], recent: Recent): Recent[] {
  return [recent, ...items.filter((r) => !(r.kind === recent.kind && r.key === recent.key))].slice(
    0,
    CAP,
  );
}

export function useSearchRecents(): SearchRecents {
  const { session } = useServerSession();
  const [items, setItems] = useState<Recent[]>(() => readLocal(session));

  // Held in a ref as well so the three verbs are stable across renders: they
  // end up in the dependency list of every row that can be tapped, and a new
  // identity per keystroke would re-render the whole results page.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    // This device's mirror first, always - the page mounts with its shortcuts
    // already drawn instead of a gap that fills a round trip later.
    setItems(readLocal(session));
    if (!session) return;
    let live = true;
    const ctrl = new AbortController();
    void fetchRecents(session, ctrl.signal)
      .then((remote) => {
        if (!live) return;
        const capped = remote.slice(0, CAP);
        setItems(capped);
        writeLocal(session, capped);
      })
      // Offline, or a server too old to have the endpoint: the mirror already
      // on screen is a better answer than emptying the row to prove a point.
      .catch(() => {});
    return () => {
      live = false;
      ctrl.abort();
    };
  }, [session]);

  const touch = useCallback((recent: Omit<Recent, 'at'>) => {
    const s = sessionRef.current;
    const full: Recent = { ...recent, at: Date.now() };
    setItems((prev) => {
      const next = withFront(prev, full);
      writeLocal(s, next);
      return next;
    });
    if (s) void touchRecent(s, recent).catch(() => {});
  }, []);

  const remove = useCallback((kind: string, key: string) => {
    const s = sessionRef.current;
    setItems((prev) => {
      const next = prev.filter((r) => !(r.kind === kind && r.key === key));
      writeLocal(s, next);
      return next;
    });
    if (s) void removeRecent(s, kind, key).catch(() => {});
  }, []);

  const clear = useCallback(() => {
    const s = sessionRef.current;
    setItems([]);
    writeLocal(s, []);
    if (s) void clearRecents(s).catch(() => {});
  }, []);

  return { items, touch, remove, clear };
}
