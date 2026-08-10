/**
 * The little language the "link a device" QR speaks.
 *
 * A desktop that is signed in encodes its server address and a one-time code
 * into a QR; a phone reads it and claims a session with no password. The same
 * string is what a scanner returns and what a human could paste, so both the
 * render side (desktop) and the read side (phone) go through here - the format
 * is defined once and cannot drift between them.
 *
 * The scheme is a URL so a scan is also a tappable deep link, and so a stray
 * scan of some other QR (a Wi-Fi code, a product link) is rejected cleanly
 * rather than half-parsed.
 */

const SCHEME = 'attackfm://pair';

/** Builds the QR/deep-link string for a server URL and a pairing code. */
export function pairPayload(url: string, code: string): string {
  return `${SCHEME}?u=${encodeURIComponent(url)}&c=${encodeURIComponent(code)}`;
}

/**
 * Reads a scanned/pasted string back into a server URL and code, or null if it
 * is not one of ours. Tolerant of surrounding whitespace; strict about the
 * scheme so foreign QR codes do not slip through.
 */
export function parsePairPayload(text: string): { url: string; code: string } | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(SCHEME)) return null;
  const q = trimmed.slice(trimmed.indexOf('?') + 1);
  const params = new URLSearchParams(q);
  const url = params.get('u');
  const code = params.get('c');
  if (!url || !code) return null;
  return { url, code };
}

const FRIEND_SCHEME = 'attackfm://friend';

/**
 * The other QR this app speaks: "this is me, add me".
 *
 * It carries a name and the server that name lives on - no secret and no
 * expiry, deliberately. A friend code is meant to sit on a screen or a sticker
 * and keep working, and it grants nothing on its own: scanning it only files a
 * request, which the person still has to accept. The server address rides
 * along so a scan taken to the wrong server fails with a sentence rather than
 * a mysterious "no account called that".
 */
export function friendPayload(url: string, username: string): string {
  return `${FRIEND_SCHEME}?u=${encodeURIComponent(url)}&n=${encodeURIComponent(username)}`;
}

export function parseFriendPayload(text: string): { url: string; username: string } | null {
  const trimmed = text.trim();
  if (!trimmed.toLowerCase().startsWith(FRIEND_SCHEME)) return null;
  const q = trimmed.slice(trimmed.indexOf('?') + 1);
  const params = new URLSearchParams(q);
  const url = params.get('u');
  const username = params.get('n');
  if (!url || !username) return null;
  return { url, username };
}

/** Two server addresses naming the same server: trailing slash and case in
 *  the host are not differences worth refusing a scan over. */
export function sameServer(a: string, b: string): boolean {
  const tidy = (s: string) => s.trim().replace(/\/+$/, '').toLowerCase();
  return tidy(a) === tidy(b);
}
