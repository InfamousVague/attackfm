import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useRegistry } from '../servers/registrySession.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { announce, publishProfile } from '../servers/registry.ts';
import { useLibrary } from '../library/library.tsx';
import { fetchStatsSummary, type StatsSummary } from './stats.ts';

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

  /* The same switch also arms the hub-side profile door (housemates seeing
     your full stats and likes). Mirrored, not merged: the registry glance
     and the hub profile are two audiences of one choice, and the mirror
     keeps a server that predates the profile feature harmless (404 is
     swallowed like any other miss). */
  useEffect(() => {
    if (!server) return;
    void import('../api/profile.ts')
      .then((m) => m.setProfileSharing(server, sharing))
      .catch(() => {});
  }, [sharing, server]);

  // The registry's copy of the switch. Off shuts the door on the published
  // profile at once (the body stays, so on is instant again); on is carried
  // by the next publish below, which sends the switch with the document.
  useEffect(() => {
    if (!registry || sharing) return;
    void publishProfile(registry.token, { sharing: false }).catch(() => {});
  }, [sharing, registry]);

  // Favourites ride the publish as names. A ref, so a heart does not restart
  // the whole announce loop - the next pass simply carries the newer list.
  const { favoriteTracks } = useLibrary();
  const favoriteTracksRef = useRef(favoriteTracks);
  favoriteTracksRef.current = favoriteTracks;

  useEffect(() => {
    if (!sharing || !registry || !server) return;
    let live = true;
    const push = async () => {
      try {
        const week = await fetchStatsSummary(server, 'week');
        if (!live) return;
        // The glance is this week's; a quiet week announces nothing and the
        // registry's copy ages out on its own. The profile below still goes:
        // a month, a year and all time are not quiet just because the week was.
        if (week.minutes > 0) {
          await announce(registry.token, {
            weekMinutes: week.minutes,
            weekTopArtist: week.topArtists[0]?.artist ?? '',
            streakDays: week.streakDays,
          });
        }
        /*
         * The whole profile, too - to the registry, where a friend on ANY
         * hub reads it. The hub's stats are the source (it is what counted
         * the listens); what travels is names and numbers, never hub ids,
         * because an id means something on one box only. The reader
         * resolves songs they own by artist and title.
         */
        const [month, year, all] = await Promise.all([
          fetchStatsSummary(server, 'month'),
          fetchStatsSummary(server, 'year'),
          fetchStatsSummary(server, 'all'),
        ]);
        if (!live) return;
        const strip = (s: StatsSummary): Record<string, unknown> => ({
          ...s,
          topArtists: s.topArtists.map(({ coverTrackId: _c, ...a }) => a),
          topTracks: s.topTracks.map(({ trackId: _t, ...t }) => t),
        });
        const favorites = favoriteTracksRef.current.slice(0, 200).map((t) => ({
          title: t.title,
          artist: t.artist,
          album: t.album,
        }));
        await publishProfile(registry.token, {
          sharing: true,
          profile: {
            v: 1,
            memberSince: null,
            serverUrl: server.url,
            ranges: { week: strip(week), month: strip(month), year: strip(year), all: strip(all) },
            favorites,
            favoritesTotal: favoriteTracksRef.current.length,
          },
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
