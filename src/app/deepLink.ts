//! Invite links, delivered into the app.
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

let pending: string | null = null;
const subscribers = new Set<(code: string) => void>();

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
