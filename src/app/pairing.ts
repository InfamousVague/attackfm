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

