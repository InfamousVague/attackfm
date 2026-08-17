import { request, type ServerSession } from './http.ts';
import type { ServerInfo } from './http.ts';

/** Asks a server what it is. The one call that needs no credentials. */
export async function fetchServerInfo(url: string, signal?: AbortSignal): Promise<ServerInfo> {
  return request<ServerInfo>(url, '/api/server', { signal });
}

interface LoginReply {
  token: string;
  streamToken: string;
  user: { id: number; username: string; isAdmin: boolean };
}

export async function login(url: string, username: string, password: string): Promise<ServerSession> {
  const reply = await request<LoginReply>(url, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
  return {
    url,
    token: reply.token,
    streamToken: reply.streamToken,
    username: reply.user.username,
    isAdmin: reply.user.isAdmin,
  };
}

/**
 * Bind your central identity to the account you already have on this server -
 * the owner's migration, so an existing library stays yours and you enter as
 * yourself from then on. Needs both proofs: the server session and the registry
 * token.
 */
export async function linkAccount(
  url: string,
  serverToken: string,
  registryToken: string,
): Promise<{ handle: string }> {
  return request<{ ok: boolean; handle: string }>(url, '/api/registry/link', {
    method: 'POST',
    token: serverToken,
    body: JSON.stringify({ token: registryToken }),
  });
}

/**
 * Sign into a server with a central-registry identity instead of a password.
 * The server verifies the registry token, admits the account (invite-gated the
 * first time), and answers with the same session a password login would - so
 * the rest of the app is none the wiser about which door was used.
 */
export async function enterServer(
  url: string,
  registryToken: string,
  invite?: string,
): Promise<ServerSession> {
  const reply = await request<LoginReply>(url, '/api/registry/enter', {
    method: 'POST',
    body: JSON.stringify({ token: registryToken, invite: invite ?? '' }),
  });
  return {
    url,
    token: reply.token,
    streamToken: reply.streamToken,
    username: reply.user.username,
    isAdmin: reply.user.isAdmin,
  };
}

/** What `POST /api/pair/start` hands a signed-in device: a code to show. */
export interface PairCode {
  code: string;
  /** Seconds the code stays good for. */
  expiresIn: number;
}

/**
 * Mints a one-time pairing code on the server this session is signed into, so
 * another device can link without a password. The desktop shows the code (as a
 * QR and as text); the phone spends it with {@link pairClaim}.
 */
export async function pairStart(session: ServerSession): Promise<PairCode> {
  return request<PairCode>(session.url, '/api/pair/start', {
    method: 'POST',
    token: session.token,
  });
}

/**
 * Turns a pairing code into a full session on `url` - the same token pair a
 * password sign-in would return, for the account that minted the code. Used by
 * the phone's "log in with a code" path.
 */
export async function pairClaim(url: string, code: string): Promise<ServerSession> {
  const reply = await request<LoginReply>(url, '/api/pair/claim', {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  return {
    url,
    token: reply.token,
    streamToken: reply.streamToken,
    username: reply.user.username,
    isAdmin: reply.user.isAdmin,
  };
}

/** Creates an account. Open on a fresh server; admin-only after that. */
export async function register(
  url: string,
  username: string,
  password: string,
  token?: string,
): Promise<void> {
  await request(url, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
    token,
  });
}

export async function logout(session: ServerSession): Promise<void> {
  // Best-effort: the local session is dropped either way, and a server that
  // cannot be reached should not trap somebody in a signed-in state.
  await request(session.url, '/api/auth/logout', { method: 'POST', token: session.token }).catch(
    () => {},
  );
}

/**
 * Mints a fresh stream token. Called when a media URL starts coming back 401,
 * which is how a stream token that aged out renews without a re-login.
 */
export async function refreshStreamToken(session: ServerSession): Promise<string> {
  const me = await request<{ streamToken: string }>(session.url, '/api/me', {
    token: session.token,
  });
  return me.streamToken;
}

/**
 * When the stream token embedded in every media URL runs out, in epoch
 * milliseconds. The token's shape is `user.epoch.expiry.sig`; anything
 * unreadable counts as already expired, which safely routes callers into the
 * renewal path.
 */
export function streamTokenExpiresAt(token: string): number {
  const expiry = Number(token.split('.')[2]);
  return Number.isFinite(expiry) ? expiry * 1000 : 0;
}
