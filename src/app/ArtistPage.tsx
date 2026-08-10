import { Button, ScrollArea, Text } from '@glacier/react';
import { Play, Shuffle } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { usePlaylists } from './playlists.tsx';
import { useServerSession } from './serverSession.tsx';
import { fetchAlbumArt } from './albumArt.ts';
import { fetchArtistTop, remotePath } from './server.ts';
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

/**
 * One artist's page, reached by tapping their name anywhere in the library. A
 * hero with the name and a play/shuffle pair, then what the listener actually
 * has of them: the songs they play most (the server's all-time counts for this
 * artist), the albums, every playlist of theirs that features the artist, and
 * the full table of their songs.
 */
export function ArtistPage({ artist, onPlay, onOpenArtist, onOpenPlaylist }: ArtistPageProps) {
  const { tracks } = useLibrary();
  const { playlists } = usePlaylists();
  const { session } = useServerSession();
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

  const heroArt =
    (albums[0] && (hiRes[albums[0].name] ?? albums[0].artwork)) ??
    theirs.find((t) => t.artwork)?.artwork ??
    placeholderArt;

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

  return (
    <div className="homePage artistPage">
      <header className="artistHero">
        <img className="artistHero__art" src={heroArt} alt="" />
        <div className="artistHero__text">
          <h1 className="artistHero__name">{artist}</h1>
          <Text tone="muted" size="sm">
            {theirs.length} {theirs.length === 1 ? 'song' : 'songs'} · {albums.length}{' '}
            {albums.length === 1 ? 'album' : 'albums'}
            {inPlaylists.length > 0 &&
              ` · in ${inPlaylists.length} ${inPlaylists.length === 1 ? 'playlist' : 'playlists'}`}
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

      {top.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Top songs</h2>
          <ol className="artistTop">
            {top.map(({ track, plays }, index) => (
              <li key={track.path}>
                <button
                  type="button"
                  className="artistTopRow"
                  onClick={() =>
                    onPlay(
                      track,
                      top.map((r) => r.track),
                    )
                  }
                >
                  <span className="artistTopRank">{index + 1}</span>
                  <img
                    className="artistTopArt"
                    src={track.artwork ?? placeholderArt}
                    alt=""
                    loading="lazy"
                  />
                  <span className="artistTopMeta">
                    <span className="artistTopTitle">{track.title}</span>
                    <span className="artistTopPlays">
                      {plays} {plays === 1 ? 'play' : 'plays'}
                    </span>
                  </span>
                  <span className="artistTopTime">{fmtDuration(track.duration)}</span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}

      {albums.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Albums</h2>
          <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
            <div className="homeShelfRow">
              {albums.map((album) => (
                <button
                  key={album.name}
                  type="button"
                  className="artistAlbum"
                  onClick={() => onPlay(album.list[0]!, album.list)}
                >
                  <img
                    className="artistAlbumCover"
                    src={hiRes[album.name] ?? album.artwork ?? placeholderArt}
                    alt=""
                    loading="lazy"
                  />
                  <span className="artistAlbumName">{album.name}</span>
                </button>
              ))}
            </div>
          </ScrollArea>
        </section>
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
                  <span className="artistPlaylistCover" aria-hidden="true">
                    {(featured.length >= 4 ? featured.slice(0, 4) : [featured[0]!]).map(
                      (t, i) => (
                        <img key={i} src={t.artwork ?? placeholderArt} alt="" loading="lazy" />
                      ),
                    )}
                  </span>
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

      <section className="homeShelf librarySongs">
        <h2 className="homeShelfTitle">All songs</h2>
        <div className="libraryBody">
          <SongTable tracks={theirs} onPlay={onPlay} onOpenArtist={onOpenArtist} />
        </div>
      </section>
    </div>
  );
}
