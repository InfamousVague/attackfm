//! Links from outside, delivered into the app.
//!
//! Two kinds arrive here now: an invite to a server, and a Spotify link the
//! phone was asked to open with AttackFM instead of Spotify.
//!
//! An invite is shared as `https://registry.attack.fm/i/<code>`. The registry's
//! landing page offers an "Open in AttackFM" button pointing at the app's own
//! scheme, `attackfm://i/<code>` (registered in the iOS Info.plist). iOS hands
//! that URL to the app; the deep-link plugin passes it here, and this pulls the
//! code out and hands it to whoever is showing Join a server.
//!
//! A tiny store rather than a context: the URL can arrive before ANY React tree
//! that cares is mounted (a cold launch straight from the link), so the code is
//! held here and replayed to each subscriber the moment it subscribes.

/** Pull the invite code out of either form of link. */
function codeFromUrl(url: string): string | null {
  // https://registry.attack.fm/i/<code>  or  attackfm://i/<code>
  const path = url.match(/\/i\/([^/?#\s]+)/i);
  if (path?.[1]) return path[1].trim();
  // attackfm://<code> — a bare scheme link, just in case.
  const bare = url.match(/^attackfm:\/\/([^/?#\s]+)/i);
  return bare?.[1]?.trim() || null;
}

/**
 * Whether this is a Spotify link, in either form the phone can hand us.
 *
 * `open.spotify.com/...` arrives when someone has turned off Spotify's own
 * link handling; `spotify:track:...` arrives from the "open with" dialog,
 * which is the door that works whether they have or not - a custom scheme
 * cannot be verified away by the app that owns it.
 */
export function spotifyLink(url: string): string | null {
  const u = url.trim();
  if (/^spotify:(track|album|artist|playlist):/i.test(u)) return u;
  if (/^https?:\/\/open\.spotify\.com\/(track|album|artist|playlist)\//i.test(u)) return u;
  /*
   * A link with a sentence around it.
   *
   * Spotify's Share does not hand over a URL, it hands over "Listen to X by Y
   * on Spotify: https://…". MainActivity already picks the URL out before
   * calling in, but relying on that would make this correct only for the one
   * caller that happens to pre-clean its input - and a share sheet is exactly
   * where unprepared text arrives.
   */
  const found = u.match(
    /(?:https?:\/\/open\.spotify\.com\/(?:track|album|artist|playlist)\/[^\s]+|spotify:(?:track|album|artist|playlist):[A-Za-z0-9]+)/i,
  );
  return found ? found[0].replace(/[.,)\]]+$/, '') : null;
}

/**
 * The same link as a web address, whatever form it arrived in.
 *
 * Handing `spotify:track:…` back to the system from inside AttackFM would
 * come straight back to AttackFM - we register that scheme now, so the app
 * would be answering its own knock. The https form goes to Spotify instead,
 * and reliably: Spotify has VERIFIED open.spotify.com, which is the same fact
 * that stops us intercepting those links and is exactly what makes them a
 * dependable way back out.
 */
export function spotifyWebUrl(url: string): string | null {
  const link = spotifyLink(url);
  if (!link) return null;
  const uri = link.match(/^spotify:(track|album|artist|playlist):([A-Za-z0-9]+)/i);
  if (uri) return `https://open.spotify.com/${uri[1]!.toLowerCase()}/${uri[2]}`;
  return link;
}

let pending: string | null = null;
const subscribers = new Set<(code: string) => void>();
let pendingLink: string | null = null;
const linkSubscribers = new Set<(url: string) => void>();

/**
 * Be told when a Spotify link arrives - now, or the moment one does.
 *
 * Same replay-on-subscribe contract as the invites above, and for the same
 * reason: opening the app FROM the link means the URL is in hand before any
 * React tree that cares has mounted.
 */
export function onSpotifyLink(handler: (url: string) => void): () => void {
  linkSubscribers.add(handler);
  if (pendingLink) handler(pendingLink);
  return () => {
    linkSubscribers.delete(handler);
  };
}

/** Taken once: a link is an errand, not a state, and replaying it on every
 *  later subscribe would re-open the importer behind the user's back. */
export function clearSpotifyLink(): void {
  pendingLink = null;
}

/** Be told when an invite arrives - now, or the moment one does. Replays the
 *  last one on subscribe, so a screen that mounts after the link still gets it. */
export function onInvite(handler: (code: string) => void): () => void {
  subscribers.add(handler);
  if (pending) handler(pending);
  return () => {
    subscribers.delete(handler);
  };
}

function deliver(url: string): void {
  const link = spotifyLink(url);
  if (link) {
    pendingLink = link;
    for (const handler of linkSubscribers) handler(link);
    return;
  }
  const code = codeFromUrl(url);
  if (!code) return;
  pending = code;
  for (const handler of subscribers) handler(code);
}

let started = false;

/** Wire up the deep-link plugin once. Safe off a device: in the browser preview
 *  the plugin import throws and this quietly does nothing. */
export async function initDeepLinks(): Promise<void> {
  if (started) return;
  started = true;
  /*
   * Android's share sheet, which is a separate road entirely.
   *
   * The deep-link plugin only carries VIEW intents. A share is ACTION_SEND,
   * and MainActivity picks the URL out of the shared text and calls this - or
   * holds it, if the app was cold-launched from the share and no page existed
   * yet, which is why we also ASK on startup.
   */
  interface SharedBridge {
    takeSharedLink?: () => string;
  }
  const bridge = (window as unknown as { AFMNative?: SharedBridge }).AFMNative;
  (window as unknown as { __AFM_SHARED_LINK__?: (url: string) => void }).__AFM_SHARED_LINK__ = (
    url: string,
  ) => deliver(url);
  try {
    const held = bridge?.takeSharedLink?.();
    if (held) deliver(held);
  } catch {
    // No bridge here (desktop, the browser preview) - nothing was shared.
  }
  try {
    const mod = await import('@tauri-apps/plugin-deep-link');
    // The link the app was cold-launched with, if any…
    const launched = await mod.getCurrent();
    if (launched) launched.forEach(deliver);
    // …and any that arrive while it is already open.
    await mod.onOpenUrl((urls) => urls.forEach(deliver));
  } catch {
    // Not in the Tauri runtime, or the plugin is unavailable here.
  }
}
