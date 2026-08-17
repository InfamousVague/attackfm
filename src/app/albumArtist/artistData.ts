/**
 * The artist page's catalogue-side data: what the server knows about an
 * artist, fetched best-effort, plus the pure builders that fold it together
 * with the listener's own shelf. Split out of ArtistPage.tsx; every hook here
 * was an inline useEffect there, moved verbatim.
 */
import { useEffect, useState } from 'react';
import {
  ServerError,
  fetchAlbumGaps,
  fetchArtistTop,
  fetchCatalogArtist,
  remotePath,
  type AlbumGap,
  type CatalogArtist,
  type CatalogRelease,
  type CatalogTrack,
  type ServerSession,
} from '../server.ts';
import { titleKey, type OwnedIndex } from '../library/owned.ts';
import { fetchAlbumArt } from './albumArt.ts';
import type { AlbumGroup } from './albums.ts';
import type { Track } from '../core/tauri.ts';

// The songs of theirs the listener actually reaches for: the server's
// all-time play counts for this artist, resolved against the synced library.
// Signed out, on an older server, or never played - the shelf simply hides.
export function useArtistTop(
  session: ServerSession | null,
  artist: string,
  tracks: Track[],
): { track: Track; plays: number }[] {
  const [top, setTop] = useState<{ track: Track; plays: number }[]>([]);
  useEffect(() => {
    setTop([]);
    if (!session) return;
    let alive = true;
    void fetchArtistTop(session, artist)
      .then((rows) => {
        if (!alive) return;
        const byPath = new Map(tracks.map((t) => [t.path, t] as const));
        setTop(
          rows
            .map((row) => {
              const track = byPath.get(remotePath(row.id));
              return track ? { track, plays: row.plays } : null;
            })
            .filter((r): r is { track: Track; plays: number } => r !== null)
            .slice(0, 5),
        );
      })
      .catch(() => {
        // An older server without the endpoint: the shelf stays hidden.
      });
    return () => {
      alive = false;
    };
    // tracks intentionally read once per artist/session change: the library is
    // already synced by the time this page opens, and re-resolving on every
    // delta would re-render the list for nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artist, session]);
  return top;
}

// Who they are, from the catalogue: the portrait and the whole discography.
// Best-effort - a failure leaves the page exactly as it was before this
// existed, which is why nothing below is allowed to depend on it.
export function useCatalogProfile(
  session: ServerSession | null,
  artist: string,
): CatalogArtist | null {
  const [profile, setProfile] = useState<CatalogArtist | null>(null);
  useEffect(() => {
    setProfile(null);
    if (!session || !artist) return;
    const ctrl = new AbortController();
    void fetchCatalogArtist(session, '', artist, ctrl.signal)
      .then(setProfile)
      .catch(() => {
        // No such artist in the catalogue, an older server, or no network.
      });
    return () => ctrl.abort();
  }, [artist, session]);
  return profile;
}

/**
 * The records this artist has that you only own part of.
 *
 * The server has been able to answer this for a while and nothing ever
 * asked. `null` means not loaded, `'old'` means a server from before the
 * endpoint - worth saying, because an empty shelf would otherwise read as
 * "you have everything".
 */
export function useAlbumGaps(
  session: ServerSession | null,
  artist: string,
): AlbumGap[] | 'old' | null {
  const [gaps, setGaps] = useState<AlbumGap[] | 'old' | null>(null);
  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    setGaps(null);
    void fetchAlbumGaps(session, artist, ctrl.signal)
      .then((rows) => {
        if (!ctrl.signal.aborted) setGaps(rows);
      })
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        setGaps(e instanceof ServerError && e.status === 404 ? 'old' : []);
      });
    return () => ctrl.abort();
  }, [session, artist]);
  return gaps;
}

// Embedded art is often a tiny thumbnail that blurs at this size, so resolve a
// crisp cover per album from the iTunes Search API, cached in localStorage.
export function useHiResCovers(artist: string, albums: AlbumGroup[]): Record<string, string> {
  const [hiRes, setHiRes] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      for (const album of albums) {
        if (!album.name || album.name === 'Unknown album') continue;
        const key = `attackfm-art:${artist}|${album.name}`;
        const cached = localStorage.getItem(key);
        if (cached) {
          setHiRes((prev) => (prev[album.name] ? prev : { ...prev, [album.name]: cached }));
          continue;
        }
        const url = await fetchAlbumArt(artist, album.name);
        if (!alive) return;
        if (url) {
          localStorage.setItem(key, url);
          setHiRes((prev) => ({ ...prev, [album.name]: url }));
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [artist, albums]);
  return hiRes;
}

// The discography: every release the catalogue knows, with your own copy
// attached where you have one, and anything you own that the catalogue never
// mentioned kept rather than dropped - your shelf is not up for debate.
//
// Albums and singles stay apart, because they answer different questions. A
// body of work is fifteen records; the thirty one-off singles beside them are
// a completist's list, and folding the two together buries the first in the
// second.
export function buildDiscography(albums: AlbumGroup[], profile: CatalogArtist | null) {
  const mine = new Map(albums.map((a) => [titleKey(a.name), a] as const));
  const claimed = new Set<string>();
  const build = (releases: readonly CatalogRelease[]) =>
    releases.map((r) => {
      const key = titleKey(r.title);
      const owned = mine.get(key) ?? null;
      if (owned) claimed.add(key);
      return {
        key: `cat:${r.id}`,
        title: r.title,
        cover: owned?.artwork ?? r.cover,
        year: r.year,
        trackCount: r.trackCount,
        /** Your copy, when you have one - the whole point of the marking. */
        owned,
        release: r as CatalogRelease | null,
      };
    });

  const records = build(profile?.albums ?? []);
  const singles = build(profile?.singles ?? []);

  // Anything of yours the catalogue never listed still belongs on the page,
  // filed with the records: a rip the catalogue has never heard of is still
  // an album you own.
  for (const a of albums) {
    const key = titleKey(a.name);
    if (claimed.has(key) || !a.name || a.name === 'Unknown album') continue;
    records.push({
      key: `mine:${a.name}`,
      title: a.name,
      cover: a.artwork,
      year: null,
      trackCount: a.list.length,
      owned: a,
      release: null,
    });
  }

  // Yours first - this is still your library's page - then the rest newest
  // first, which is how a discography is read.
  const order = <T extends { owned: unknown; year: string | null }>(rows: T[]) =>
    rows.sort((x, y) => {
      if (!!x.owned !== !!y.owned) return x.owned ? -1 : 1;
      return (y.year ?? '').localeCompare(x.year ?? '');
    });
  return { records: order(records), singles: order(singles) };
}

/** One row of the discography grid, exactly as buildDiscography shapes it. */
export type DiscRow = ReturnType<typeof buildDiscography>['records'][number];

/**
 * The Popular list: the catalogue's ranking of their best-known songs, with
 * your own copy attached where you have one.
 *
 * Falls back to your play counts only when the catalogue has nothing - not
 * as the normal case. A list built from what you own says an artist's top
 * songs are the two you happen to have, which is a chart of one listener;
 * but with no catalogue to ask (offline, an older server, an artist it does
 * not know), your own counts beat showing nothing at all.
 */
export function buildPopular(
  artist: string,
  owned: OwnedIndex,
  profile: CatalogArtist | null,
  top: { track: Track; plays: number }[],
) {
  const fromCatalogue = (profile?.top ?? []).map((t) => ({
    id: t.id,
    title: t.title,
    cover: t.cover,
    duration: t.duration,
    importable: t.importable,
    url: t.url,
    mine: owned.find(artist, t.title),
    catalogue: t as CatalogTrack | null,
  }));
  if (fromCatalogue.length > 0) return fromCatalogue;
  return top.map(({ track }) => ({
    id: track.path,
    title: track.title,
    cover: track.artwork,
    duration: track.duration,
    importable: false,
    url: '',
    mine: track,
    catalogue: null,
  }));
}

/** One row of the Popular list, whichever source built it. */
export type PopularRow = ReturnType<typeof buildPopular>[number];
