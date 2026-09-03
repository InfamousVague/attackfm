import { useEffect } from 'react';
import { fetchNewMusic } from '../api/newMusic.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { discoveryNoticesEnabled } from '../settings/behaviourPrefs.ts';
import { dismissNotice, noteNotice } from './notices.ts';

/**
 * "There's new music picked for you," in the bell.
 *
 * The app builds a shelf of music you do NOT own yet - harvested from artists
 * near what you play, measured and scored and grouped by the model - and until
 * now it said nothing when that shelf gained anything. On a phone, where the
 * server cannot push, the only way to find out was to open Discover and notice
 * it was different. This is the watcher that tells you instead.
 *
 * A STANDING POOL, so it seeds like the activity watcher rather than the friend
 * one: the first time it sees this account's pool it records what is there and
 * says nothing, because a shelf that was already full when you installed is not
 * news. After that, only ids that were not in the baseline are fresh, and a
 * tick that finds some rings ONCE - an album's worth of new picks is one
 * arrival to a person, not a column of rows.
 *
 * The baseline lives in localStorage, per account, NOT in the notice ring: the
 * ring is bounded to fifty and can be cleared by hand, and a dedupe that leaned
 * on it would re-announce the whole pool the day it rolled over. Scoped by
 * account, so signing in as somebody else reads their own absent key and seeds
 * afresh rather than showing them your week.
 */

/** Slow news. The pool is rebuilt on the server's own unhurried schedule, so a
 *  five-minute look is plenty and costs one request per tick per device. */
const POLL_MS = 5 * 60 * 1000;

/** localStorage, per account. `ids` is the last-seen pool (the baseline fresh
 *  is measured against); `lastId` is the notice currently standing, so a new
 *  ring can replace it and the bell holds one discovery row, not a pile. */
interface Seen {
  ids: string[];
  lastId: string;
}

function keyFor(url: string, user: string): string {
  return `attackfm-newmusic-seen:${url}:${user}`;
}

/** Read the baseline, or null when this account has never been observed - which
 *  is the difference between "seed silently" and "measure fresh". */
function readSeen(key: string): Seen | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Seen>;
    return {
      ids: Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === 'string') : [],
      lastId: typeof parsed.lastId === 'string' ? parsed.lastId : '',
    };
  } catch {
    return null;
  }
}

function writeSeen(key: string, seen: Seen): void {
  try {
    localStorage.setItem(key, JSON.stringify(seen));
  } catch {
    // A full or disabled store just means this device re-seeds next launch and
    // stays quiet until then - a lost notice, never a wrong one.
  }
}

export function NewMusicNotices() {
  const { session } = useServerSession();

  useEffect(() => {
    if (!session) return;
    const key = keyFor(session.url, session.username);
    let alive = true;
    const ctrl = new AbortController();

    const look = async () => {
      // Off by the listener's choice, checked at emit time so the switch bites
      // on the very next tick without this remounting.
      if (!discoveryNoticesEnabled()) return;
      // A backgrounded webview should not wake the network on a timer; a pool
      // that grew is still grown when the phone comes back.
      if (document.visibilityState === 'hidden') return;

      let lists;
      try {
        lists = await fetchNewMusic(session, ctrl.signal);
      } catch {
        // Unreachable hub, or a fetch aborted on cleanup - not news; next tick.
        return;
      }
      if (!alive) return;

      // Every track across every themed set, flattened. The first of each fresh
      // one carries the cover the row will wear.
      const items = lists.flatMap((l) => l.items);
      const currentIds = items.map((t) => t.id);
      const current = new Set(currentIds);

      const seen = readSeen(key);
      if (seen === null) {
        // First sight of this account's pool: record it, say nothing. A shelf
        // that was already full is not an arrival.
        writeSeen(key, { ids: currentIds, lastId: '' });
        return;
      }

      const baseline = new Set(seen.ids);
      const fresh = items.filter((t) => !baseline.has(t.id));
      // An empty or unchanged pool restates nothing. The baseline is left as it
      // was so a later addition is still measured against the same floor.
      if (fresh.length === 0) return;

      const lead = fresh[0]!;
      const id = `newmusic:${lead.id}`;
      // One rolling row: drop the previous discovery notice before raising the
      // new one, so the bell holds the latest rather than a stack of them.
      if (seen.lastId && seen.lastId !== id) dismissNotice(seen.lastId);

      noteNotice({
        id,
        kind: 'newmusic',
        title: 'New music picked for you',
        body:
          fresh.length === 1
            ? `“${lead.title}” by ${lead.artist} — in Discover.`
            : `${fresh.length} fresh tracks picked for your taste — in Discover.`,
        // A catalogue cover, already a full remote URL. It must NOT go through
        // artSized (that rewrites a LIBRARY art id into a sized path and would
        // mangle this); null is a fine fallback and draws the compass glyph.
        art: lead.cover || null,
        door: 'discover',
        // No `song`: these are not owned, so a tray tap that tried to start one
        // would resolve to nothing. The tray entry just opens the app; the
        // in-app row uses the door.
        at: Date.now(),
      });

      // The floor moves up to what is here now, and remembers the row it left
      // standing. Bounded: this is the pool, tens of ids, not a growing union.
      writeSeen(key, { ids: currentIds, lastId: id });
    };

    void look();
    const timer = window.setInterval(() => void look(), POLL_MS);
    // A phone brought back to the front should not wait out the rest of a tick.
    const onWake = () => void look();
    document.addEventListener('visibilitychange', onWake);
    return () => {
      alive = false;
      ctrl.abort();
      document.removeEventListener('visibilitychange', onWake);
      window.clearInterval(timer);
    };
  }, [session]);

  return null;
}
