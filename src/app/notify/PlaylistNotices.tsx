import { useEffect, useRef } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { useLibrary } from '../library/library.tsx';
import { usePlaylists, type Playlist } from '../playlists/playlists.tsx';
import { forgetSharedSeen, isSharedSeen } from '../playlists/sharedSeen.ts';
import { verboseNoticesEnabled } from '../settings/behaviourPrefs.ts';
import { fetchPlaylistActivity, type PlaylistActivityItem } from '../api/playlistActivity.ts';
import { artUrl } from '../api/library.ts';
import type { ServerSession } from '../api/http.ts';
import { dismissNotice, noteNotice, notices } from './notices.ts';

/**
 * Shared playlists, in the bell.
 *
 * A friend sharing a list with you used to leave exactly one trace: a
 * "Shared by" kicker inside a page you had no reason to open, on a tile that
 * looked like all your own. And a song they added to a list you share left
 * none at all - the list was quietly one longer. This watcher turns the
 * hub's own ledger of those events (`/api/playlists/activity`) into rows.
 *
 * Same family as FriendNotices and ShareNotices, and separate from the
 * verbose watcher for the same reason they are: a share is ADDRESSED to you -
 * somebody chose your name - and an add is to a list you are on. Those ring
 * whether or not verbose is on. The housekeeping kinds (a song taken out,
 * somebody leaving, a list withdrawn) are chatter, and sit behind the switch.
 *
 * TWO TENSES. A share is a STANDING STATE: the list is still sitting there
 * unopened, so the row stays up - across launches, the ring persists - until
 * you open the list, which is what takes it down (PlaylistPage marks it
 * seen and dismisses). An add is an EVENT: news once, then history.
 *
 * THE CURSOR. Each poll asks for everything after the last answer's `now`,
 * remembered per hub-and-account in localStorage, so a relaunch does not
 * re-ring a fortnight. A device with no cursor at all (a fresh install, or a
 * hub that just grew the route) asks for the last fourteen days and rings
 * ONLY the shares from that backlog - a share is still news while the list
 * is unopened, an add from last Tuesday is not.
 *
 * BURSTS. Somebody filling a list adds ten songs in five minutes, and ten
 * rows for that is the noise a bell gets blamed for. Adds by one person to
 * one list within ten minutes of the first share a row, re-noted as the
 * count grows: same id, same kind, so notices.ts rewrites it in place and
 * the tray hears about it once.
 *
 * A 404 is a hub from before the route. Nothing moves, nothing rings, and
 * the next tick asks again - the hub upgrading is the ordinary way this
 * comes to exist.
 */

/** The shared-list heartbeat the store already runs; the same cadence here. */
const POLL_MS = 30_000;
/** A cap, not a page: past this the older rows are stale news. The cursor
 *  moves to the server's `now` regardless, so nothing repeats. */
const LIMIT = 50;
/** How far back a device with no cursor looks, for standing shares. */
const FIRST_LOOK_MS = 14 * 24 * 60 * 60 * 1000;
/** Adds inside this window of the first, by one person to one list, are one row. */
const BURST_MS = 10 * 60_000;
const CURSOR_KEY = 'attackfm-playlist-activity-since';
/** How many handled row ids to remember, for the repeat guard below. */
const REMEMBER = 500;

function cursorKey(session: ServerSession): string {
  return `${CURSOR_KEY}:${session.url}:${session.username}`;
}

function readCursor(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function writeCursor(key: string, at: number): void {
  try {
    localStorage.setItem(key, String(at));
  } catch {
    // Storage refusing costs a re-ring on the next launch, nothing worse.
  }
}

function songCount(n: number): string {
  return n === 1 ? '1 song' : `${n} songs`;
}

/** "Dreams, Everywhere and 3 more" - the burst row's body. */
function burstBody(titles: readonly string[]): string {
  const shown = titles.slice(0, 2);
  const rest = titles.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/** A share announced before the store knew the list - the row went out with
 *  the name alone, and is dressed with its count and cover when the list
 *  arrives (see the effect on `playlists` below). */
interface Undressed {
  actorName: string;
  playlistName: string;
  at: number;
}

/** The store's copy of a shared list, from the poll's point of view. */
function listOf(playlists: readonly Playlist[], pid: string): Playlist | undefined {
  return playlists.find((p) => !p.origin && p.id === pid);
}

/** The list's cover for a row: the chosen one, else its first song's. */
function coverOf(list: Playlist | undefined, tracks: readonly { path: string; artwork: string | null }[]): string | null {
  if (!list) return null;
  if (list.coverUrl) return list.coverUrl;
  const byPath = new Map(tracks.map((t) => [t.path, t] as const));
  for (const path of list.paths) {
    const t = byPath.get(path);
    if (t?.artwork) return t.artwork;
  }
  return null;
}

/** The standing share row, from what is known. */
function sharedNotice(pid: string, who: Undressed, list: Playlist | undefined, art: string | null) {
  return {
    id: `playlist-shared:${pid}`,
    kind: 'playlist-shared',
    title: `${who.actorName} shared a playlist with you`,
    body: list ? `${who.playlistName} · ${songCount(list.paths.length)}` : who.playlistName,
    art,
    door: 'playlist' as const,
    playlist: pid,
    at: who.at,
  };
}

/** Adds by one person to one list, within ten minutes of the first. */
interface Burst {
  /** The notice id - stable for the burst's life, so re-notes replace. */
  id: string;
  startedAt: number;
  titles: string[];
  /** The newest song's cover, for the row. */
  art: string | null;
}

export function PlaylistNotices(): null {
  const { session } = useServerSession();
  const { playlists } = usePlaylists();
  const { tracks } = useLibrary();
  // The poll closure outlives every render; refs keep its view of the store
  // current without re-arming the timer on each heartbeat of the library.
  const playlistsRef = useRef(playlists);
  playlistsRef.current = playlists;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  /** Bursts under way, by `${playlistId}:${actorId}`. Memory only, on
   *  purpose: after a relaunch the cursor has moved past their rows. */
  const bursts = useRef(new Map<string, Burst>());
  /**
   * Row ids already turned into notices this run. The cursor is what keeps a
   * poll from re-reading history, but a cursor is a clock and a row is a
   * fact: a row stamped a hair before the `now` the last answer carried, or
   * a hub whose clock wobbles, would come back and count a song twice into
   * a burst. A friend request has its id for the same reason. Bounded.
   */
  const handled = useRef(new Set<number>());
  /** Share rows raised before the store held the list, by playlist id. */
  const undressed = useRef(new Map<string, Undressed>());

  /*
   * Dress the rows the store caught up with. On a cold launch the first poll
   * can answer before the playlists have - a fresh install has no feed cache
   * to seed from - and a row that says only "Night bus" is poorer than one
   * that says "Night bus · 5 songs" over its cover. Same id, same kind: the
   * ring rewrites the row in place, keeps its read flag, and the tray does
   * not hear about it twice. A row the reader has since dismissed is left
   * dismissed - re-noting an id that is gone would append it afresh.
   */
  useEffect(() => {
    if (undressed.current.size === 0) return;
    for (const [pid, who] of [...undressed.current]) {
      const list = listOf(playlists, pid);
      if (!list) continue;
      const art = coverOf(list, tracks);
      // The list is here but the library is not yet: its cover is a song's,
      // and the songs land a beat after the lists on a cold start. Wait for
      // them - but not for a list that simply has no art, which would wait
      // forever.
      if (art === null && tracks.length === 0) continue;
      undressed.current.delete(pid);
      const id = `playlist-shared:${pid}`;
      if (!notices().some((n) => n.id === id)) continue;
      noteNotice(sharedNotice(pid, who, list, art));
    }
  }, [playlists, tracks]);

  useEffect(() => {
    if (!session) {
      bursts.current.clear();
      handled.current.clear();
      undressed.current.clear();
      return;
    }
    let alive = true;
    const controller = new AbortController();
    const hub = session.url;
    const key = cursorKey(session);

    const handle = (it: PlaylistActivityItem, backlog: boolean) => {
      const pid = String(it.playlistId);
      const sharedId = `playlist-shared:${pid}`;
      switch (it.kind) {
        case 'shared': {
          // Already opened on this device: not news, whatever the backlog says.
          if (isSharedSeen(hub, pid)) return;
          const who: Undressed = { actorName: it.actorName, playlistName: it.playlistName, at: it.at };
          const list = listOf(playlistsRef.current, pid);
          if (list) undressed.current.delete(pid);
          else undressed.current.set(pid, who);
          noteNotice(sharedNotice(pid, who, list, coverOf(list, tracksRef.current)));
          return;
        }
        case 'unshared': {
          // Bookkeeping first, backlog or not: a share that was taken back
          // must not stand in the bell, and a fresh share of the same list
          // later is new again.
          dismissNotice(sharedId);
          undressed.current.delete(pid);
          forgetSharedSeen(hub, pid);
          if (backlog || !verboseNoticesEnabled()) return;
          noteNotice({
            id: `playlist-unshared:${it.id}`,
            kind: 'playlist-unshared',
            title: `${it.actorName} stopped sharing ${it.playlistName}`,
            body: 'It is no longer among your playlists.',
            art: null,
            door: null,
            at: it.at,
          });
          return;
        }
        case 'added': {
          if (backlog) return;
          const song = it.track;
          const bkey = `${pid}:${it.actorId}`;
          let burst = bursts.current.get(bkey);
          if (!burst || it.at - burst.startedAt > BURST_MS) {
            burst = {
              id: `playlist-add:${pid}:${it.actorId}:${Math.floor(it.at / BURST_MS)}`,
              startedAt: it.at,
              titles: [],
              art: null,
            };
            bursts.current.set(bkey, burst);
          }
          burst.titles.push(song?.title || 'a song');
          if (song?.artId) burst.art = artUrl(session, song.artId, song.id);
          const n = burst.titles.length;
          if (n === 1) {
            noteNotice({
              id: burst.id,
              kind: 'playlist-add',
              title: `${it.actorName} added to ${it.playlistName}`,
              body: song ? `${song.title} — ${song.artist}` : 'A song',
              art: burst.art,
              door: 'playlist',
              playlist: pid,
              // One song is an offer to hear it: the tray tap starts it.
              ...(song ? { song: { title: song.title, artist: song.artist } } : {}),
              at: it.at,
            });
          } else {
            noteNotice({
              id: burst.id,
              kind: 'playlist-add',
              title: `${it.actorName} added ${n} songs to ${it.playlistName}`,
              body: burstBody(burst.titles),
              art: burst.art,
              door: 'playlist',
              playlist: pid,
              at: it.at,
            });
          }
          return;
        }
        case 'removed': {
          if (backlog || !verboseNoticesEnabled()) return;
          noteNotice({
            id: `playlist-removed:${it.id}`,
            kind: 'playlist-removed',
            title: `${it.actorName} removed from ${it.playlistName}`,
            body: it.track ? `${it.track.title} — ${it.track.artist}` : 'A song',
            art: null,
            door: 'playlist',
            playlist: pid,
            at: it.at,
          });
          return;
        }
        case 'left': {
          if (backlog || !verboseNoticesEnabled()) return;
          noteNotice({
            id: `playlist-left:${it.id}`,
            kind: 'playlist-left',
            title: `${it.actorName} left ${it.playlistName}`,
            body: 'They no longer see the list.',
            art: null,
            door: 'playlist',
            playlist: pid,
            at: it.at,
          });
          return;
        }
        default:
          // A kind this build does not know: the server may grow one, and a
          // row with no words is worse than none.
          return;
      }
    };

    const look = async () => {
      // A backgrounded webview should not be waking the network on a timer;
      // the cursor has not moved, so the next foreground tick catches up.
      if (document.visibilityState === 'hidden') return;
      const stored = readCursor(key);
      const backlog = stored === null;
      const since = backlog ? Date.now() - FIRST_LOOK_MS : stored;
      try {
        const page = await fetchPlaylistActivity(session, since, LIMIT, controller.signal);
        if (!alive || page === null) return;
        // Oldest first, so a share followed by its withdrawal resolves in the
        // order it happened rather than leaving the withdrawn share standing.
        const items = [...page.items].sort((a, b) => a.at - b.at || a.id - b.id);
        for (const it of items) {
          if (handled.current.has(it.id)) continue;
          handled.current.add(it.id);
          if (handled.current.size > REMEMBER) {
            // Sets iterate in insertion order: the eldest goes first.
            const eldest = handled.current.values().next().value;
            if (eldest !== undefined) handled.current.delete(eldest);
          }
          handle(it, backlog);
        }
        writeCursor(key, page.now);
      } catch {
        // A hub that is asleep is not news; the next tick tries again.
      }
    };

    void look();
    const timer = window.setInterval(() => void look(), POLL_MS);
    // Coming back to the app is the moment somebody most wants the news, and
    // the moment the hidden-tab guard above has been skipping.
    const onShow = () => {
      if (document.visibilityState === 'visible') void look();
    };
    document.addEventListener('visibilitychange', onShow);
    return () => {
      alive = false;
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [session]);

  return null;
}
