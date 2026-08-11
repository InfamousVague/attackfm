import { Button, ScrollArea, Text } from '@glacier/react';
import { Check, Disc3, Music, Play, Plus, Shuffle, X } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { usePlaylists } from './playlists.tsx';
import { useServerSession } from './serverSession.tsx';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../plugins/runtime.tsx';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';
import type { AcquireTarget } from '../plugins/types.ts';
import { fetchAlbumArt } from './albumArt.ts';
import { mosaicArts, useArtLoad, useTileArt } from './artLoad.ts';
import { PROBE_URL, importable, resolveImportable } from './resolveImport.ts';
import {
  artSized,
  fetchArtistTop,
  fetchCatalogArtist,
  remotePath,
  type CatalogArtist,
  type CatalogRelease,
  type CatalogTrack,
} from './server.ts';
import { titleKey, useOwned } from './owned.ts';
import { SongTable } from './SongTable.tsx';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

interface ArtistPageProps {
  artist: string;
  /** Receives the opened track and the artist's list in its displayed order. */
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Opens one of the listener's playlists - the "In your playlists" shelf. */
  onOpenPlaylist?: (id: string) => void;
}

// mm:ss for the top-songs rows; the table below formats its own.
function fmtDuration(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '--:--';
  const total = Math.round(seconds);
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, '0')}`;
}

/** A record's cover in the discography grid: skeleton while the bytes come,
 *  pop on arrival. A component of its own so the hook lives outside the map
 *  that draws the grid. */
function DiscCover({ src }: { src: string }) {
  const sized = artSized(src, 640) ?? src;
  const art = useArtLoad(sized, 'artistAlbumCover');
  return <img {...art} src={sized} alt="" loading="lazy" />;
}

/** A popular row's thumbnail: the same treatment at list size. */
function CatalogArt({ src }: { src: string }) {
  const sized = artSized(src, 160) ?? src;
  const art = useArtLoad(sized, 'catalogTrack__art');
  return <img {...art} src={sized} alt="" loading="lazy" />;
}

/** A playlist card's stacked covers, loading as ONE artwork: the tile holds
 *  its shimmer until every cover has answered, then reveals whole. Four
 *  distinct covers or a single one - two or three would leave holes in the
 *  quadrant grid. */
function PlaylistTile({ featured }: { featured: Track[] }) {
  const arts = mosaicArts(featured.map((t) => t.artwork));
  const urls = arts.length >= 4 ? arts : [arts[0] ?? placeholderArt];
  const { loaded, hostRef } = useTileArt(urls);
  return (
    <span
      ref={hostRef}
      className="artistPlaylistCover"
      aria-hidden="true"
      data-tile-pop=""
      data-tile-loading={!loaded || undefined}
    >
      {urls.map((u, i) => (
        <img key={i} src={u} alt="" loading="lazy" />
      ))}
    </span>
  );
}

/**
 * One artist's page, reached by tapping their name anywhere in the library.
 *
 * It opens as a view of what you HAVE - the songs you play most, your albums,
 * your playlists that feature them, the full table - and then fills in who they
 * are from the catalogue: their portrait in the hero, and their whole
 * discography under it with your own records marked.
 *
 * The discography is the point of asking the catalogue at all. Your shelf shows
 * the four albums you own; it cannot show you the eleven you do not, and "what
 * else did they make" is the question an artist page exists to answer. Records
 * you own play; the rest offer an Add where the importer can honour one.
 *
 * Everything catalogue-side is additive and best-effort: signed out, offline,
 * or on an older server, the page is exactly what it was before.
 */
export function ArtistPage({ artist, onPlay, onOpenArtist, onOpenPlaylist }: ArtistPageProps) {
  const { tracks } = useLibrary();
  const { playlists } = usePlaylists();
  const { session } = useServerSession();
  const acquire = useAcquire();
  const downloads = useDownloadsOptional();
  const owned = useOwned();
  const theirs = useMemo(() => tracks.filter((t) => t.artist === artist), [tracks, artist]);

  // One entry per album, taking the first cover the album offers, with the
  // album's own tracks in disc order as its play-through queue.
  const albums = useMemo(() => {
    const byAlbum = new Map<string, { name: string; artwork: string | null; list: Track[] }>();
    for (const track of theirs) {
      const name = track.album || 'Unknown album';
      const existing = byAlbum.get(name);
      if (!existing) byAlbum.set(name, { name, artwork: track.artwork, list: [track] });
      else {
        existing.list.push(track);
        if (!existing.artwork && track.artwork) existing.artwork = track.artwork;
      }
    }
    for (const album of byAlbum.values()) {
      album.list.sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0));
    }
    return [...byAlbum.values()];
  }, [theirs]);

  // The songs of theirs the listener actually reaches for: the server's
  // all-time play counts for this artist, resolved against the synced library.
  // Signed out, on an older server, or never played - the shelf simply hides.
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

  // Who they are, from the catalogue: the portrait and the whole discography.
  // Best-effort - a failure leaves the page exactly as it was before this
  // existed, which is why nothing below is allowed to depend on it.
  const [profile, setProfile] = useState<CatalogArtist | null>(null);
  // What a tapped record is doing. A record you do not own carries a Deezer
  // link the importer will not take, so the tap searches for its Spotify
  // twin first - which takes a beat and can come back empty, and both of
  // those have to be visible on the row that was tapped.
  const [adding, setAdding] = useState<Record<string, 'finding' | 'added' | 'missing'>>({});
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

  // The listener's own playlists that feature this artist, each wearing the
  // covers of the artist's songs inside it.
  const inPlaylists = useMemo(() => {
    const byPath = new Map(theirs.map((t) => [t.path, t] as const));
    return playlists
      .map((playlist) => {
        const featured = playlist.paths
          .map((p) => byPath.get(p))
          .filter((t): t is Track => t !== undefined);
        return featured.length > 0 ? { playlist, featured } : null;
      })
      .filter((r): r is { playlist: (typeof playlists)[number]; featured: Track[] } => r !== null);
  }, [playlists, theirs]);

  // Embedded art is often a tiny thumbnail that blurs at this size, so resolve a
  // crisp cover per album from the iTunes Search API, cached in localStorage.
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

  // The discography: every release the catalogue knows, with your own copy
  // attached where you have one, and anything you own that the catalogue never
  // mentioned kept rather than dropped - your shelf is not up for debate.
  //
  // Albums and singles stay apart, because they answer different questions. A
  // body of work is fifteen records; the thirty one-off singles beside them are
  // a completist's list, and folding the two together buries the first in the
  // second.
  const discography = useMemo(() => {
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
  }, [albums, profile]);

  type DiscRow = (typeof discography)['records'][number];

  const ownedRecords = discography.records.filter((r) => r.owned).length;

  const heroArt =
    artSized(
      profile?.picture ??
        (albums[0] && (hiRes[albums[0].name] ?? albums[0].artwork)) ??
        theirs.find((t) => t.artwork)?.artwork ??
        null,
      640,
    ) ?? placeholderArt;
  const heroLoad = useArtLoad(heroArt, 'artistHero__art');

  // Play-through order for the hero buttons: albums in shelf order, discs in
  // track order - the same order the page presents.
  const playThrough = useMemo(() => albums.flatMap((a) => a.list), [albums]);
  const shuffled = () => {
    const pool = [...theirs];
    for (let i = pool.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    return pool;
  };

  /**
   * Pull a record you do not own.
   *
   * The link the discography carries is Deezer's, which the importer refuses as
   * primary input, so this finds the same record on Spotify by name first and
   * hands the importer that. The row says what is happening throughout, because
   * a search over the network is long enough that a silent button reads as a
   * broken one.
   */
  const addRecord = async (row: DiscRow) => {
    if (!session || adding[row.key]) return;
    setAdding((prev) => ({ ...prev, [row.key]: 'finding' }));

    // Already importable (a Spotify link, one day) - no need to go looking.
    if (row.release && importable(row.release)) {
      take('album', row.title, row.release.url);
      setAdding((prev) => ({ ...prev, [row.key]: 'added' }));
      return;
    }

    let found = null;
    try {
      found = await resolveImportable(session, 'album', artist, row.title);
    } catch {
      // Offline or the catalogue refused; indistinguishable from "not there"
      // as far as the row is concerned.
    }
    if (!found) {
      setAdding((prev) => ({ ...prev, [row.key]: 'missing' }));
      // Long enough to read, then the row goes back to being a live offer so
      // the tap doubles as the retry.
      window.setTimeout(
        () =>
          setAdding((prev) => {
            const next = { ...prev };
            delete next[row.key];
            return next;
          }),
        4000,
      );
      return;
    }
    take('album', found.title, found.url);
    setAdding((prev) => ({ ...prev, [row.key]: 'added' }));
  };

  /**
   * Pull one of the artist's best-known songs. The same two steps a record
   * takes - find the Spotify twin of a Deezer link, then hand it over - kept
   * separate only because a song's key and copy differ from a record's.
   */
  const addSong = async (t: CatalogTrack) => {
    if (!session || adding[t.id]) return;
    setAdding((prev) => ({ ...prev, [t.id]: 'finding' }));
    if (importable(t)) {
      take('track', t.title, t.url);
      setAdding((prev) => ({ ...prev, [t.id]: 'added' }));
      return;
    }
    let found = null;
    try {
      found = await resolveImportable(session, 'track', artist, t.title);
    } catch {
      // Same outcome as not being there.
    }
    if (!found) {
      setAdding((prev) => ({ ...prev, [t.id]: 'missing' }));
      window.setTimeout(
        () =>
          setAdding((prev) => {
            const next = { ...prev };
            delete next[t.id];
            return next;
          }),
        4000,
      );
      return;
    }
    take('track', found.title, found.url);
    setAdding((prev) => ({ ...prev, [t.id]: 'added' }));
  };

  /**
   * Hand a resolved record to whatever will fetch it.
   *
   * Straight down the importer's own queue when it is running - "start the
   * import" is the whole point of having looked the record up, and routing
   * through the generic chooser would put a dialog between the tap and the
   * download. With the importer off, the chooser is right: something else
   * (Buy) may still be able to get it.
   */
  const take = (kind: 'album' | 'track', title: string, url: string) => {
    const target: AcquireTarget = { kind, title, artist, url };
    const viaImporter = acquire.handlersFor(target).some((h) => h.pluginId === IMPORTER_PLUGIN_ID);
    if (viaImporter && downloads) void downloads.enqueue(url).catch(() => {});
    else acquire.acquire(target);
  };

  /** How many times this listener has played a track of theirs, or null when
   *  the server has no count for it (signed out, older server, never played). */
  const playsFor = (path: string): number | null =>
    top.find((r) => r.track.path === path)?.plays ?? null;

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
  const popular = useMemo(() => {
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
  }, [artist, owned, profile, top]);

  /** One record in the discography. Yours plays; the rest can be pulled, via a
   *  Spotify lookup when their own link is one the importer will not take. */
  const discCard = (row: DiscRow) => {
    const state = adding[row.key];
    // "Would anything take an album link, if I found one?" - probed with a
    // Spotify-shaped URL because a downloader's canHandle tests for one, so
    // asking with the empty string would always answer no.
    const canAdd =
      !row.owned &&
      session !== null &&
      acquire.hasHandlers({ kind: 'album', title: row.title, artist, url: PROBE_URL });
    const act = row.owned
      ? () => onPlay(row.owned!.list[0]!, row.owned!.list)
      : canAdd && !state
        ? () => void addRecord(row)
        : undefined;
    const cover = (row.owned && hiRes[row.owned.name]) || row.cover;
    return (
      <button
        key={row.key}
        type="button"
        className="artistAlbum"
        data-have={row.owned ? '' : undefined}
        data-state={state}
        disabled={!act}
        title={
          row.owned
            ? `Play ${row.title}`
            : state === 'missing'
              ? `${row.title} is not on Spotify to import`
              : canAdd
                ? `Add ${row.title}`
                : `${row.title} — no way to add this; enable Music import or Buy in Plugins`
        }
        onClick={act}
      >
        <span className="artistAlbumArt">
          {cover ? (
            <DiscCover src={cover} />
          ) : (
            <span className="artistAlbumCover artistAlbumCover--glyph" aria-hidden>
              <Disc3 size={26} />
            </span>
          )}
          {/* Owned is the state worth a mark and Add is an offer; a record that
              is neither says nothing rather than wearing a badge meaning "no". */}
          {row.owned ? (
            <span className="artistAlbumBadge" data-have>
              <Check size={13} />
            </span>
          ) : state === 'finding' ? (
            <span className="artistAlbumBadge" data-busy>
              <span className="artistAlbumSpin" aria-label="Finding it on Spotify" />
            </span>
          ) : state === 'added' ? (
            <span className="artistAlbumBadge" data-have>
              <Check size={13} />
            </span>
          ) : state === 'missing' ? (
            <span className="artistAlbumBadge" data-missing>
              <X size={13} />
            </span>
          ) : canAdd ? (
            <span className="artistAlbumBadge">
              <Plus size={13} />
            </span>
          ) : null}
        </span>
        <span className="artistAlbumName">{row.title}</span>
        <span className="artistAlbumSub">
          {state === 'finding'
            ? 'Finding it…'
            : state === 'added'
              ? downloads
                ? 'Added to downloads'
                : 'Sent to add'
              : state === 'missing'
                ? 'Not on Spotify'
                : [
                    row.year,
                    row.owned
                      ? `${row.owned.list.length} of ${row.trackCount ?? row.owned.list.length}`
                      : row.trackCount
                        ? `${row.trackCount} tracks`
                        : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
        </span>
      </button>
    );
  };

  return (
    <div className="homePage artistPage">
      <header className="artistHero">
        <img {...heroLoad} src={heroArt} alt="" />
        <div className="artistHero__text">
          <h1 className="artistHero__name">{artist}</h1>
          <Text tone="muted" size="sm">
            {theirs.length === 0 ? (
              // Nothing of theirs yet - reached from a catalogue search row.
              // Counting your zero songs and zero albums would be a page
              // telling you what you already know.
              <>
                Artist
                {discography.records.length > 0 &&
                  ` · ${discography.records.length} ${
                    discography.records.length === 1 ? 'album' : 'albums'
                  } to explore`}
              </>
            ) : (
              <>
                {theirs.length} {theirs.length === 1 ? 'song' : 'songs'} · {albums.length}{' '}
                {albums.length === 1 ? 'album' : 'albums'}
                {/* Of how many there are to have - the number that turns a shelf
                    into a discography. Records only: counting the singles would
                    say "3 of 45" for an artist with fifteen albums. */}
                {discography.records.length > albums.length && ` of ${discography.records.length}`}
                {inPlaylists.length > 0 &&
                  ` · in ${inPlaylists.length} ${
                    inPlaylists.length === 1 ? 'playlist' : 'playlists'
                  }`}
              </>
            )}
          </Text>
        </div>
        {theirs.length > 0 && (
          <div className="artistHero__actions">
            <Button
              variant="solid"
              size="sm"
              onClick={() => onPlay(playThrough[0]!, playThrough)}
            >
              <Play size={15} />
              <span>Play</span>
            </Button>
            <Button
              variant="soft"
              size="sm"
              onClick={() => {
                const pool = shuffled();
                onPlay(pool[0]!, pool);
              }}
            >
              <Shuffle size={15} />
              <span>Shuffle</span>
            </Button>
          </div>
        )}
      </header>

      {popular.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Popular</h2>
          {/* The artist's best-known songs as the CATALOGUE ranks them, not as
              your own shelf does. This used to be a list of your play counts,
              which meant an artist you owned two songs by had a "top songs" of
              exactly those two - a chart of one listener is not a chart. Your
              counts survive as a line on the rows you do own. A song you have
              plays; the rest are one tap from your downloads. */}
          <ol className="catalogTracks">
            {popular.map((t, index) => {
              const state = adding[t.id];
              const mine = t.mine;
              const plays = mine ? playsFor(mine.path) : null;
              return (
                <li key={t.id} className="catalogTrack">
                  <span className="catalogTrack__rank">{index + 1}</span>
                  {t.cover ? (
                    <CatalogArt src={t.cover} />
                  ) : (
                    <span className="catalogTrack__art catalogTrack__art--glyph" aria-hidden>
                      <Music size={16} />
                    </span>
                  )}
                  {/* Owning it makes the row a play button; otherwise the title
                      is a label and the only control is the add. */}
                  {mine ? (
                    <button
                      type="button"
                      className="catalogTrack__title catalogTrack__title--play"
                      onClick={() => onPlay(mine, theirs)}
                    >
                      {t.title}
                    </button>
                  ) : (
                    <span className="catalogTrack__title">{t.title}</span>
                  )}
                  {/* Your own count, where the server has one - the part of the
                      old shelf worth keeping. */}
                  {plays !== null && (
                    <span className="catalogTrack__plays">
                      {plays.toLocaleString()} {plays === 1 ? 'play' : 'plays'}
                    </span>
                  )}
                  <span className="catalogTrack__time">{fmtDuration(t.duration)}</span>
                  {/* Nothing to add for a song you already have, and nothing to
                      add when this row came from your own library in the first
                      place (the catalogue was unreachable). */}
                  {mine || !t.catalogue ? (
                    <span className="catalogTrack__add" data-state="added" aria-hidden>
                      <Check size={14} />
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="catalogTrack__add"
                      data-state={
                        state === 'added'
                          ? 'added'
                          : state === 'missing'
                            ? 'missing'
                            : state === 'finding'
                              ? 'adding'
                              : 'idle'
                      }
                      disabled={state !== undefined || !session}
                      aria-label={
                        state === 'missing' ? `${t.title} is not on Spotify` : `Add ${t.title}`
                      }
                      title={
                        state === 'missing' ? `${t.title} is not on Spotify to import` : undefined
                      }
                      onClick={() => void addSong(t.catalogue!)}
                    >
                      {state === 'added' ? (
                        <Check size={14} />
                      ) : state === 'finding' ? (
                        <span className="artistAlbumSpin" aria-label="Finding it on Spotify" />
                      ) : state === 'missing' ? (
                        <X size={14} />
                      ) : (
                        <Plus size={14} />
                      )}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {(discography.records.length > 0 || discography.singles.length > 0) && (
        <>
          {discography.records.length > 0 && (
            <section className="homeShelf">
              <h2 className="homeShelfTitle">
                Albums
                <span className="artistDiscCount">
                  {ownedRecords} of {discography.records.length}
                </span>
              </h2>
              {/* A grid rather than the horizontal shelf the rest of the page
                  uses: a discography is read, not skimmed past, and a body of
                  work fifteen records deep does not belong behind a sideways
                  scroll. */}
              <div className="artistDisc">{discography.records.map(discCard)}</div>
            </section>
          )}

          {discography.singles.length > 0 && (
            <section className="homeShelf">
              <h2 className="homeShelfTitle">
                Singles &amp; EPs
                <span className="artistDiscCount">{discography.singles.length}</span>
              </h2>
              <div className="artistDisc">{discography.singles.map(discCard)}</div>
            </section>
          )}

          {/* Said once, under the discography: a record you do not own is a
              tap away, it just takes a beat to find first. */}
          {[...discography.records, ...discography.singles].some((r) => !r.owned) && (
            <Text tone="muted" size="sm" className="artistDiscNote">
              Tap anything you do not own and it is looked up on Spotify and sent to your
              downloads.
            </Text>
          )}
        </>
      )}

      {inPlaylists.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">In your playlists</h2>
          <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
            <div className="homeShelfRow">
              {inPlaylists.map(({ playlist, featured }) => (
                <button
                  key={playlist.id}
                  type="button"
                  className="artistPlaylist"
                  onClick={() => onOpenPlaylist?.(playlist.id)}
                >
                  <PlaylistTile featured={featured} />
                  <span className="artistPlaylistName">{playlist.name}</span>
                  <span className="artistPlaylistCount">
                    {featured.length} {featured.length === 1 ? 'song' : 'songs'} of theirs
                  </span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </section>
      )}

      {theirs.length > 0 && (
        <section className="homeShelf librarySongs">
          <h2 className="homeShelfTitle">All songs</h2>
          <div className="libraryBody">
            <SongTable tracks={theirs} onPlay={onPlay} onOpenArtist={onOpenArtist} />
          </div>
        </section>
      )}

      {/* Nothing of theirs and nothing from the catalogue either: say so rather
          than leaving a hero over an empty page. */}
      {theirs.length === 0 &&
        popular.length === 0 &&
        discography.records.length === 0 &&
        discography.singles.length === 0 && (
          <Text tone="muted" size="sm" className="artistDiscNote">
            {profile === null && session
              ? 'Looking them up…'
              : `Nothing found for ${artist} — the catalogue does not know them.`}
          </Text>
        )}
    </div>
  );
}
