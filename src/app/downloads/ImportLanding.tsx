import { useEffect, useRef } from 'react';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { usePlaylists } from '../playlists/playlists.tsx';
import { openPlaylistById } from '../nav/playlistDoor.ts';
import { openDownloadsPane } from '../nav/downloadsDoor.ts';
import { expectedLandings, forgetLanding, planLandings } from './importLanding.ts';

/**
 * Takes you to the playlist a pasted link became.
 *
 * Headless, and mounted once beside DownloadNotices for the same reasons:
 * inside the plugin providers, so there is a queue to read, and inside the
 * playlists provider, so the list the hub just made can be fetched before
 * the page for it opens (a playlist page whose list the store does not know
 * steps straight back out). The decision itself is planLandings; this is
 * the part that cannot be pure - performing it, once per paste.
 *
 * It also keeps the playlist store honest while a staged import runs: the
 * store refetches on a slow heartbeat, and the marks the hub writes on wants
 * it could not find would otherwise sit unseen for half a minute after the
 * download ended. So a watched job crossing into done or error asks for a
 * refresh then, not at the next tick.
 */
export function ImportLanding() {
  const dl = useDownloadsOptional();
  const { refresh } = usePlaylists();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  /** Pastes whose landing is already being performed, so a poll that arrives
   *  during the store refresh does not open the page twice. */
  const opening = useRef<Set<string>>(new Set());
  /** The last seen state of every job that carries a playlist. */
  const staged = useRef<Map<string, string>>(new Map());

  const jobs = dl?.jobs;
  useEffect(() => {
    if (!jobs) return;

    const plan = planLandings(expectedLandings(), jobs, Date.now());
    for (const url of plan.stale) forgetLanding(url);
    for (const url of plan.fallback) {
      forgetLanding(url);
      openDownloadsPane();
    }
    for (const { url, playlistId } of plan.open) {
      if (opening.current.has(url)) continue;
      opening.current.add(url);
      forgetLanding(url);
      // The store must hold the list before the page is asked for it.
      void Promise.resolve(refreshRef.current?.())
        .catch(() => {
          // Unreachable right now; the page falls back to the list as the
          // store last knew it, which is the one thing it cannot open. The
          // heartbeat brings it, and the bell row will still get you there.
        })
        .finally(() => {
          opening.current.delete(url);
          openPlaylistById(String(playlistId));
        });
    }

    // Staged imports ending: the wants' fate is written server-side at that
    // moment, so read it now.
    let ended = false;
    for (const j of jobs) {
      if (typeof j.playlistId !== 'number') continue;
      const was = staged.current.get(j.id);
      const over = j.state === 'done' || j.state === 'error';
      if (was !== undefined && !(was === 'done' || was === 'error') && over) ended = true;
      staged.current.set(j.id, j.state);
    }
    if (ended) void refreshRef.current?.();
  }, [jobs]);

  return null;
}
