// Split up: data hooks + discography/popular builders live in artistData.ts,
// the shared adding-state acquire flow in artistAcquire.ts, and the Popular /
// Missing-from-your-albums / discography sections in ArtistPopular.tsx,
// ArtistGaps.tsx and ArtistDiscography.tsx.
import { Button, ScrollArea, Text } from '@glacier/react';
import { Play, Shuffle } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { setHeaderActions } from '../nav/headerActions.ts';
import { usePlaylists } from '../playlists/playlists.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { groupAlbums, isBy } from './albums.ts';
import { mosaicArts, useArtLoad, useTileArt } from '../ux/artLoad.ts';
import { artSized } from '../server.ts';
import { useOwned } from '../library/owned.ts';
import { SongTable } from '../library/SongTable.tsx';
import type { Track } from '../core/tauri.ts';
import {
  buildDiscography,
  buildPopular,
  useAlbumGaps,
  useArtistTop,
  useCatalogProfile,
  useHiResCovers,
} from './artistData.ts';
import { useArtistAcquire } from './artistAcquire.ts';
import { ArtistDiscography } from './ArtistDiscography.tsx';
import { ArtistGaps } from './ArtistGaps.tsx';
import { ArtistPopular } from './ArtistPopular.tsx';
import placeholderArt from '../../assets/attack-wave.png';

interface ArtistPageProps {
  artist: string;
  /** Receives the opened track and the artist's list in its displayed order. */
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Opens a record you own. A cover is a door; playing it is what the play
   *  button on the page behind it is for. */
  onOpenAlbum?: (album: string, albumArtist: string) => void;
  /** Opens one of the listener's playlists - the "In your playlists" shelf. */
  onOpenPlaylist?: (id: string) => void;
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
export function ArtistPage({ artist, onPlay, onOpenArtist,
  onOpenAlbum, onOpenPlaylist }: ArtistPageProps) {
  const { tracks } = useLibrary();
  const { playlists } = usePlaylists();
  const { session } = useServerSession();
  const owned = useOwned();
  /**
   * Everything of theirs, which is a wider net than it looks.
   *
   * A track counts as this artist's when EITHER credit names them: the track
   * artist, or the album artist. Matching the track artist alone - which this
   * did - loses every song with a guest on it ("X feat. Y" is not "X"), and
   * with it whole records, because an album only appeared here if at least one
   * of its songs was credited to the bare name. That is the same bug reading
   * as three separate ones: too few songs in the count, too few albums on the
   * shelf, and an album's own tally short of what is actually on the disk.
   *
   * Folded case-insensitively for the same reason the server's own artist
   * queries are: two spellings of one name must not become two artists.
   */
  const theirs = useMemo(() => tracks.filter((t) => isBy(t, artist)), [tracks, artist]);

  // One entry per album, each in running order, as the play-through queue.
  const albums = useMemo(() => groupAlbums(theirs), [theirs]);

  const top = useArtistTop(session, artist, tracks);
  const profile = useCatalogProfile(session, artist);
  const gaps = useAlbumGaps(session, artist);
  const hiRes = useHiResCovers(artist, albums);
  const { adding, addRecord, addSong, addMissing, canAddAlbum, downloads } =
    useArtistAcquire(artist, session);

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

  const discography = useMemo(() => buildDiscography(albums, profile), [albums, profile]);

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

  /*
   * The hero scrolls away; the header picks up its name and its two buttons -
   * the same arrangement the song collections and playlists use. All hooks
   * above the render and none below a branch, which is the rule this page has
   * always kept and the one a playlist briefly did not.
   */
  const pageRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const root = pageRef.current;
    const mark = sentinelRef.current;
    if (!root || !mark) return;
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!entry?.isIntersecting),
      { root, threshold: 0 },
    );
    observer.observe(mark);
    return () => observer.disconnect();
    // Re-armed per artist: opening another replaces the hero the sentinel sits
    // under.
  }, [artist]);

  const handlers = useRef({ playThrough, shuffled, onPlay });
  handlers.current = { playThrough, shuffled, onPlay };
  useEffect(() => {
    // Nothing of theirs on this device is nothing to play - the hero hides its
    // own buttons in that case, and the header must agree.
    if (!stuck || theirs.length === 0) return;
    setHeaderActions({
      title: artist,
      // A person, so it is round - the same shape their portrait wears in the
      // hero above and on every artist card in the app.
      art: heroArt,
      artRound: true,
      play: () => {
        const list = handlers.current.playThrough;
        if (list[0]) handlers.current.onPlay(list[0], list);
      },
      shuffle: () => {
        const pool = handlers.current.shuffled();
        if (pool[0]) handlers.current.onPlay(pool[0], pool);
      },
      disabled: false,
    });
    return () => setHeaderActions(null);
  }, [stuck, artist, theirs.length, heroArt]);

  /** How many times this listener has played a track of theirs, or null when
   *  the server has no count for it (signed out, older server, never played). */
  const playsFor = (path: string): number | null =>
    top.find((r) => r.track.path === path)?.plays ?? null;

  const popular = useMemo(
    () => buildPopular(artist, owned, profile, top),
    [artist, owned, profile, top],
  );

  return (
    <div className="homePage artistPage" ref={pageRef}>
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
      {/* Sits just under the hero: once this leaves the top of the page, the
          hero has gone with it. */}
      <div ref={sentinelRef} className="songPageHead__sentinel" aria-hidden />

      <ArtistPopular
        popular={popular}
        adding={adding}
        addSong={addSong}
        playsFor={playsFor}
        theirs={theirs}
        session={session}
        onPlay={onPlay}
      />

      <ArtistGaps gaps={gaps} adding={adding} addMissing={addMissing} />

      <ArtistDiscography
        artist={artist}
        discography={discography}
        adding={adding}
        addRecord={addRecord}
        canAddAlbum={canAddAlbum}
        hiRes={hiRes}
        hasDownloads={downloads !== null}
        onPlay={onPlay}
        onOpenAlbum={onOpenAlbum}
      />

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
