import { useEffect, useSyncExternalStore } from 'react';
import { useRegistry } from './registrySession.tsx';
import { useServerSession } from './serverSession.tsx';
import { announce } from './registry.ts';
import { fetchStatsSummary } from './stats.ts';

/**
 * Sharing your listening with friends - the weekly glance behind the friends
 * page.
 *
 * ON by default, and only for people who have never said otherwise: an
 * explicit `off` is honoured forever, so nobody who once turned this off is
 * quietly turned back on by a later release. Without a default the friends
 * page is a grid of empty cards - the numbers are what make it about music
 * rather than a contact list - and a friend is someone you already accepted.
 *
 * Turning the switch off needs no un-share round trip: the announcements just
 * stop, the registry's copy goes stale, and friends stop seeing it within the
 * week. Silence IS the revocation.
 *
 * The glance is deliberately tiny, and that is what makes the default
 * defensible. No track list, no history, no timestamps - three numbers and a
 * name, the same altitude as the "796 songs" the registry has always shown
 * friends, and visible only to accounts you have accepted.
 */

const SHARE_KEY = 'attackfm-share-listening';
/** How often a standing session re-announces. */
const REANNOUNCE_MS = 6 * 60 * 60 * 1000;

const listeners = new Set<() => void>();

export function sharingEnabled(): boolean {
  try {
    // Only an explicit refusal turns it off. Anything else - never asked, or
    // a value from some older build - reads as on.
    return localStorage.getItem(SHARE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setSharing(on: boolean): void {
  try {
    localStorage.setItem(SHARE_KEY, on ? 'on' : 'off');
  } catch {
    // A store that will not write costs the preference, not the page.
  }
  for (const l of listeners) l();
}

/** The switch's state, live across every component that shows it. */
export function useSharing(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    sharingEnabled,
    // The server-render fallback matches the default, or the switch would
    // flash off on first paint for everyone who never touched it.
    () => true,
  );
}

/**
 * Headless: pushes the glance while sharing is on. Mounted once at app level,
 * so sharing works without ever visiting the stats page.
 */
export function ListeningShareBridge() {
  const { session: registry } = useRegistry();
  const { session: server } = useServerSession();
  const sharing = useSharing();

  useEffect(() => {
    if (!sharing || !registry || !server) return;
    let live = true;
    const push = async () => {
      try {
        const week = await fetchStatsSummary(server, 'week');
        if (!live || week.minutes === 0) return;
        await announce(registry.token, {
          weekMinutes: week.minutes,
          weekTopArtist: week.topArtists[0]?.artist ?? '',
          streakDays: week.streakDays,
        });
      } catch {
        // Offline, or a server without the stats build: nothing to share yet.
      }
    };
    void push();
    const timer = window.setInterval(() => void push(), REANNOUNCE_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [sharing, registry, server]);

  return null;
}
