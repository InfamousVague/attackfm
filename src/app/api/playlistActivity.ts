import { request, ServerError, type ServerSession } from './http.ts';

/**
 * What happened on the playlists you share: the hub's own log of who shared
 * a list with you, who added a song to one, who took one out, who left.
 *
 * The server keeps the ledger and does the entitlement arithmetic: the
 * caller's OWN actions are never in the answer (you know what you did), and
 * neither is anything on a list the caller is not on. What comes back is
 * addressed to the reader, which is what lets the client turn rows straight
 * into bell notices without a second look at the store.
 *
 * Polled, like the activity feed beside it, and for the same reason: the one
 * live socket reaches only a device with a stream open, and a phone in a
 * pocket has none. Thirty seconds is the shared-list heartbeat already.
 */
export type PlaylistActivityKind = 'shared' | 'added' | 'removed' | 'left' | 'unshared';

export interface PlaylistActivityTrack {
  id: number;
  title: string;
  artist: string;
  /** The cover's art id, for `artUrl`. '' or absent when the song has none. */
  artId?: string | null;
}

export interface PlaylistActivityItem {
  id: number;
  playlistId: number;
  playlistName: string;
  ownerId: number;
  ownerName: string;
  /** Who did it. For `shared` and `unshared` this is the owner. */
  actorId: number;
  actorName: string;
  kind: PlaylistActivityKind;
  /** The song, for `added` and `removed`; null for the membership kinds. */
  track: PlaylistActivityTrack | null;
  /** Epoch MILLISECONDS - this route, unlike the older ones, speaks ms. */
  at: number;
}

export interface PlaylistActivityPage {
  /** The server's clock at the moment of the answer, ms. The next `since`. */
  now: number;
  /** Newest first. */
  items: PlaylistActivityItem[];
}

/**
 * Everything after `sinceMs` (exclusive), newest first, at most `limit` rows.
 *
 * NULL on a hub that predates the route (404) - the caller goes quiet, moves
 * nothing and asks again next tick, because a hub upgrade is the ordinary
 * way this comes to exist and there is no version of the feature worth an
 * error over. Anything else - a hub asleep, a 500 - throws as usual.
 *
 * Tolerant of a body that is not the contract: a fixture, a proxy page, an
 * older shape answer as "nothing happened" rather than as a crash in a poll.
 */
export async function fetchPlaylistActivity(
  session: ServerSession,
  sinceMs: number,
  limit = 50,
  signal?: AbortSignal,
): Promise<PlaylistActivityPage | null> {
  const q = new URLSearchParams({ since: String(Math.max(0, Math.floor(sinceMs))), limit: String(limit) });
  let reply: unknown;
  try {
    reply = await request<unknown>(session.url, `/api/playlists/activity?${q}`, {
      token: session.token,
      signal,
    });
  } catch (err) {
    if (err instanceof ServerError && err.status === 404) return null;
    throw err;
  }
  const page = reply as Partial<PlaylistActivityPage> | null;
  const items = Array.isArray(page?.items) ? page.items.filter(isItem) : [];
  const now = typeof page?.now === 'number' && Number.isFinite(page.now) ? page.now : Date.now();
  return { now, items };
}

function isItem(x: unknown): x is PlaylistActivityItem {
  if (!x || typeof x !== 'object') return false;
  const it = x as Partial<PlaylistActivityItem>;
  return (
    typeof it.id === 'number' &&
    typeof it.playlistId === 'number' &&
    typeof it.playlistName === 'string' &&
    typeof it.actorId === 'number' &&
    typeof it.actorName === 'string' &&
    typeof it.kind === 'string' &&
    typeof it.at === 'number'
  );
}
