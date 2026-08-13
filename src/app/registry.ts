//! The client's side of the central identity directory.
//!
//! Every AttackFM account lives in one place - the registry - not on a music
//! server. This module is how the app talks to it: create an account, sign in,
//! and manage the friends graph that spans every server. A music server is
//! something an account JOINS; identity comes first, and comes from here.
//!
//! The base URL is fixed to the production registry. It is overridable at build
//! time for a self-hosted directory, but the default is the one directory the
//! whole network shares - that is the point of it being central.

const REGISTRY_URL =
  (import.meta.env?.VITE_REGISTRY_URL as string | undefined)?.replace(/\/$/, '') ||
  'https://registry.attack.fm';

/** A signed-in registry identity: the token servers trust, and who it is. */
export interface RegistryAccount {
  id: number;
  handle: string;
}

export interface RegistrySession {
  token: string;
  account: RegistryAccount;
}

export class RegistryError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RegistryError';
  }
}

async function call<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<T> {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (rest.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${REGISTRY_URL}${path}`, { ...rest, headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new RegistryError(response.status, detail || `${response.status} ${response.statusText}`);
  }
  // Some endpoints answer 200 with an empty body.
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

// --- account ---------------------------------------------------------------

/** Create a central account with a password. Returns a signed-in session. */
export async function signup(handle: string, password: string): Promise<RegistrySession> {
  return call<RegistrySession>('/v1/signup', {
    method: 'POST',
    body: JSON.stringify({ handle, password }),
  });
}

/** Sign in with a password. */
export async function login(handle: string, password: string): Promise<RegistrySession> {
  return call<RegistrySession>('/v1/login', {
    method: 'POST',
    body: JSON.stringify({ handle, password }),
  });
}

/** Swap a still-valid token for a fresh one, so a long session renews. */
export async function refresh(token: string): Promise<RegistrySession> {
  return call<RegistrySession>('/v1/refresh', { method: 'POST', token });
}

/** Tell the registry where this account's library answers and how big it is,
 *  so friends see numbers and can reach it without waking it. */
export async function announce(
  token: string,
  info: {
    serverUrl?: string;
    songs?: number;
    playlists?: number;
    artists?: number;
    /** The listening glance - sent only while sharing is ON. Absence lets the
     *  registry's copy go stale, which is how sharing turns off: by silence. */
    weekMinutes?: number;
    weekTopArtist?: string;
    streakDays?: number;
  },
): Promise<void> {
  await call('/v1/announce', { method: 'POST', token, body: JSON.stringify(info) });
}

// --- friends ---------------------------------------------------------------

export interface RegistryFriend {
  id: number;
  handle: string;
  serverUrl: string;
  seenAt: number;
  songs: number;
  playlists: number;
  artists: number;
  /** The listening glance, null when they do not share (or stopped - the
   *  registry hides anything older than a week). Absent from old registries. */
  weekMinutes?: number | null;
  weekTopArtist?: string | null;
  streakDays?: number | null;
}

export interface RegistryRequest {
  id: number;
  accountId: number;
  handle: string;
}

export interface FriendsFeed {
  friends: RegistryFriend[];
  incoming: RegistryRequest[];
  outgoing: RegistryRequest[];
}

export async function fetchFriends(token: string): Promise<FriendsFeed> {
  const out = await call<Partial<FriendsFeed>>('/v1/friends', { token });
  return { friends: out.friends ?? [], incoming: out.incoming ?? [], outgoing: out.outgoing ?? [] };
}

/** Ask someone by handle. If they already asked you, you become friends now. */
export async function sendFriendRequest(
  token: string,
  handle: string,
): Promise<{ friends: boolean; message: string }> {
  return call('/v1/friends/requests', { method: 'POST', token, body: JSON.stringify({ handle }) });
}

export async function acceptFriendRequest(token: string, id: number): Promise<void> {
  await call(`/v1/friends/requests/${id}/accept`, { method: 'POST', token });
}

export async function declineFriendRequest(token: string, id: number): Promise<void> {
  await call(`/v1/friends/requests/${id}/decline`, { method: 'POST', token });
}

export async function removeFriend(token: string, accountId: number): Promise<void> {
  await call(`/v1/friends/${accountId}`, { method: 'DELETE', token });
}

// --- invites ---------------------------------------------------------------

/** A server owner mints an invite; the code is what an invite link carries. */
export async function createInvite(
  token: string,
  serverUrl: string,
  serverName: string,
): Promise<{ code: string; serverUrl: string; expiresAt: number }> {
  return call('/v1/invites', {
    method: 'POST',
    token,
    body: JSON.stringify({ serverUrl, serverName }),
  });
}

export interface InvitePreview {
  serverUrl: string;
  serverName: string;
  from: string;
  spent: boolean;
  expired: boolean;
}

/** Look at an invite before redeeming it. No token needed. */
export async function previewInvite(code: string): Promise<InvitePreview> {
  return call(`/v1/invites/${encodeURIComponent(code)}`);
}

/** Spend an invite: the signed-in account joins the server it names. */
export async function redeemInvite(
  token: string,
  code: string,
): Promise<{ serverUrl: string; serverName: string; role: string }> {
  return call(`/v1/invites/${encodeURIComponent(code)}/redeem`, { method: 'POST', token });
}

/**
 * An invite link the app can share. The code alone is enough to redeem; the
 * link wraps it so it can be sent to somebody who has never seen the app.
 *
 * What a tap on it actually does, and why it is not simpler:
 *
 * `GET /i/{code}` on the registry serves a landing page (invite_landing in
 * crates/registry) - the server's name, who sent it, an "Open in AttackFM"
 * button pointing at `attackfm://i/{code}`, and the code in plain text to
 * paste. The browser is in the middle of that on purpose. For this https link
 * to open the app DIRECTLY, the build needs a
 * `com.apple.developer.associated-domains` entitlement and the registry needs
 * an apple-app-site-association file - and an entitlement the provisioning
 * profile does not grant makes a device build fail to sign, the same trap the
 * CarPlay key sits in. The custom scheme needs no entitlement and no
 * capability, so the button works today at the cost of one tap.
 *
 * The scheme is registered in gen/apple/app_iOS/Info.plist (CFBundleURLTypes).
 * That file is rewritten on every build and loses its XML comments, which is
 * why this explanation lives here instead.
 */
export function inviteLink(code: string): string {
  return `${REGISTRY_URL}/i/${code}`;
}

export { REGISTRY_URL };

// --- the servers this account can reach ------------------------------------

/**
 * One server saved to the account.
 *
 * Addresses, not credentials. The account remembers WHERE you listen; each
 * device still mints its own tokens by re-proving membership through
 * `/api/registry/enter`. That split is the whole security story: a registry
 * breach leaks a list of hostnames, not a way into anyone's music.
 */
export interface Membership {
  serverUrl: string;
  serverName: string;
  role: string;
  state: 'active' | 'pending' | string;
  since: number;
}

/** Every server saved to this account, across all its devices. */
export async function fetchMemberships(token: string): Promise<Membership[]> {
  const reply = await call<{ memberships: Membership[] }>('/v1/memberships', { token });
  return reply.memberships ?? [];
}

/** Save a server to the account, so the next device is handed it. */
export async function recordMembership(
  token: string,
  entry: { serverUrl: string; serverName?: string; role?: string },
): Promise<void> {
  await call('/v1/memberships', {
    method: 'POST',
    token,
    body: JSON.stringify({
      serverUrl: entry.serverUrl,
      serverName: entry.serverName ?? '',
      role: entry.role ?? 'member',
    }),
  });
}

/** Stop syncing a server to this account. Membership on the server itself is
 *  untouched - this only forgets the entry in the directory. */
export async function forgetMembership(token: string, serverUrl: string): Promise<void> {
  await call('/v1/memberships', {
    method: 'POST',
    token,
    body: JSON.stringify({ serverUrl, forget: true }),
  });
}
