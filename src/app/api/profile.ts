import { request, type ServerSession } from './http.ts';
import { normalizeStatsSummary, type StatsRange, type StatsSummary } from '../profile/stats.ts';

// --- member profiles -------------------------------------------------------
//
// The full profile of a member of THIS server - the same stats payload their
// own stats page is built from, plus their liked songs as track ids (this
// library is shared, so ids resolve locally). The server refuses with 403
// when they keep their listening to themselves; callers show a closed door.

export interface MemberProfile {
  userId: number;
  username: string;
  /** Registry handle when they joined through the registry; '' otherwise. */
  handle: string;
  memberSince: number | null;
  sharing: boolean;
  stats: StatsSummary;
  /** Liked songs, newest heart first, as server track ids (capped). */
  favorites: number[];
  favoritesTotal: number;
}

export async function fetchMemberProfile(
  session: ServerSession,
  who: string,
  range: StatsRange,
  tzMin: number,
): Promise<MemberProfile> {
  const raw = await request<Record<string, unknown>>(
    session.url,
    `/api/profile/${encodeURIComponent(who)}?range=${range}&tzMin=${tzMin}`,
    { token: session.token },
  );
  return {
    userId: Number(raw.userId ?? 0),
    username: typeof raw.username === 'string' ? raw.username : '',
    handle: typeof raw.handle === 'string' ? raw.handle : '',
    memberSince: typeof raw.memberSince === 'number' ? raw.memberSince : null,
    sharing: raw.sharing !== false,
    stats: normalizeStatsSummary(raw.stats, range),
    favorites: Array.isArray(raw.favorites) ? raw.favorites.filter((n): n is number => typeof n === 'number') : [],
    favoritesTotal: typeof raw.favoritesTotal === 'number' ? raw.favoritesTotal : 0,
  };
}

/** The caller's own door: whether housemates may see their full profile. */
export async function fetchProfileSharing(session: ServerSession): Promise<boolean> {
  const out = await request<{ sharing?: boolean }>(session.url, '/api/profile/sharing', {
    token: session.token,
  });
  return out.sharing !== false;
}

export async function setProfileSharing(session: ServerSession, sharing: boolean): Promise<void> {
  await request(session.url, '/api/profile/sharing', {
    token: session.token,
    method: 'PUT',
    body: JSON.stringify({ sharing }),
  });
}
