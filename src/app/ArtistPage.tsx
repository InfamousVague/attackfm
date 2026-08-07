import { ScrollArea, Text } from '@glacier/react';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { fetchAlbumArt } from './albumArt.ts';
import { SongTable } from './SongTable.tsx';
import type { Track } from './tauri.ts';
import placeholderArt from '../assets/attack-wave.png';

interface ArtistPageProps {
  artist: string;
  /** Receives the opened track and the artist's list in its displayed order. */
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
}

/**
 * One artist's page: a header with the name and the artist's albums as covers,
 * then the library table filtered to that artist's tracks. The way back lives in
 * the top bar rather than here.
 */
export function ArtistPage({ artist, onPlay, onOpenArtist }: ArtistPageProps) {
  const { tracks } = useLibrary();
  const theirs = useMemo(() => tracks.filter((t) => t.artist === artist), [tracks, artist]);

  // One entry per album, taking the first cover the album offers.
  const albums = useMemo(() => {
    const byAlbum = new Map<string, { name: string; artwork: string | null }>();
    for (const track of theirs) {
      const name = track.album || 'Unknown album';
      const existing = byAlbum.get(name);
      if (!existing) byAlbum.set(name, { name, artwork: track.artwork });
      else if (!existing.artwork && track.artwork) existing.artwork = track.artwork;
    }
    return [...byAlbum.values()];
  }, [theirs]);

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

  return (
    <>
      <header className="stripHeader">
        <div className="stripHeading">
          <span className="stripTitle">{artist}</span>
          <Text tone="muted" size="sm">
            {theirs.length} {theirs.length === 1 ? 'song' : 'songs'} · {albums.length}{' '}
            {albums.length === 1 ? 'album' : 'albums'}
          </Text>
        </div>
        {albums.length > 0 && (
          <ScrollArea orientation="horizontal" className="artistAlbums" hideScrollbar>
            <div className="artistAlbumsRow">
              {albums.map((album) => (
                <div key={album.name} className="artistAlbum">
                  <img className="artistAlbumCover" src={hiRes[album.name] ?? album.artwork ?? placeholderArt} alt="" loading="lazy" />
                  <span className="artistAlbumName">{album.name}</span>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </header>
      <div className="libraryBody">
        <SongTable tracks={theirs} onPlay={onPlay} onOpenArtist={onOpenArtist} />
      </div>
    </>
  );
}
