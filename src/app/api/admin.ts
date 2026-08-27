import { request, type ServerSession } from './http.ts';

// --- the server dashboard ----------------------------------------------------

/** The numbers behind Settings > Server, from `GET /api/stats` in one call.
 * Disk fields are null when the box could not answer (no `df`); the whole
 * fetch fails on a server that predates the endpoint - callers fall back to
 * the scan status they already poll. */
export interface ServerStats {
  version: string;
  name: string;
  uptimeSecs: number;
  tracks: number;
  users: number;
  bytesUsed: number;
  bytesLabel: string;
  quotaBytes: number;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  /* What the box itself is doing. Null where it will not say - an older hub
     sends none of these, and a platform we cannot read memory on sends the
     memory pair as null while still answering for load. Every reader has to
     treat "absent" and "zero" as different things. */
  cpuCount: number | null;
  loadAvg1: number | null;
  loadAvg5: number | null;
  loadAvg15: number | null;
  memTotalBytes: number | null;
  memAvailableBytes: number | null;
  transcode: boolean;
  importsQueued: number;
  importsActive: number;
}

export async function fetchServerStats(session: ServerSession): Promise<ServerStats> {
  return request<ServerStats>(session.url, '/api/stats', { token: session.token });
}

// --- user management (admin) -------------------------------------------------

export interface ServerUser {
  id: number;
  username: string;
  isAdmin: boolean;
}

/** The account list. Admin only - a listener gets a 403. */
export async function fetchUsers(session: ServerSession): Promise<ServerUser[]> {
  const reply = await request<{ users: ServerUser[] }>(session.url, '/api/users', {
    token: session.token,
  });
  return reply.users;
}

/** Removes an account outright. The server refuses self-deletion. */
export async function deleteUser(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/users/${id}`, { method: 'DELETE', token: session.token });
}

/** Kills every stream token the account holds - each device must sign in again
 * to keep listening. The account itself stays. */
export async function revokeUserStreams(session: ServerSession, id: number): Promise<void> {
  await request(session.url, `/api/users/${id}/revoke`, { method: 'POST', token: session.token });
}
