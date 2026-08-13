import type { ServerSession } from './server.ts';

/**
 * The library you have authorized to be copied FROM.
 *
 * The app signs into one server at a time, but a mirror needs credentials for
 * two at once - the destination has to be able to read the source. So the
 * source is authorized in a separate step, while you are signed into it, and
 * what that leaves behind is this: a copy of its address and its tokens, held
 * until you hand them to the other server or revoke them.
 *
 * Kept apart from the live session on purpose. It is a standing permission
 * rather than a login: signing out of the source does not revoke it (you are
 * meant to sign out - that is how you get to the other server), and clearing it
 * is an explicit act.
 *
 * These ARE credentials for your library. They live in this device's own
 * storage, they are only ever sent to a server you choose, and the Revoke
 * button is the one that makes them stop existing.
 */

const KEY = 'attackfm-mirror-source';

export interface MirrorSource {
  url: string;
  /** Display only - whose library this is, on the card. */
  name: string;
  username: string;
  /** Reads the library listing. */
  token: string;
  /** Fetches the audio; the stream endpoint takes it in the query string. */
  streamToken: string;
  authorizedAt: number;
}

export function readMirrorSource(): MirrorSource | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as MirrorSource;
    return v && typeof v.url === 'string' && typeof v.token === 'string' ? v : null;
  } catch {
    return null;
  }
}

/** Authorize the session you are signed in with as a source to copy from. */
export function authorizeMirrorSource(session: ServerSession, name: string): MirrorSource {
  const entry: MirrorSource = {
    url: session.url,
    name: name || session.url,
    username: session.username,
    token: session.token,
    streamToken: session.streamToken,
    authorizedAt: Date.now(),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(entry));
  } catch {
    // Storage refused: the authorization simply does not persist, and the
    // card will show none - which is honest, rather than a silent half-state.
  }
  return entry;
}

export function revokeMirrorSource(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to do; the next read fails closed.
  }
}
