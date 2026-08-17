import { ScrollArea } from '@glacier/react';
import { Sparkles } from '@glacier/icons';
import { useState } from 'react';
import { mosaicArts, useArtLoad, useCardArt, useTileArt } from '../ux/artLoad.ts';
import { artworkHue, artworkUrl, mixArtwork } from '../ux/artwork.ts';
import type { Track } from '../core/tauri.ts';
import { AlbumMenu } from '../albumArtist/AlbumMenu.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';

/**
 * The home page's card atoms and shelf frame - shared by every rendering of
 * the shelves (Home, Discover's curator half, Library's history half).
 */

export function greetingFor(hour: number): string {
  if (hour < 5) return 'Up late';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** Blank line the skeleton holds so the card keeps its exact height. */
export const NBSP = ' ';

/** One square track card on a shelf. */
export function TrackCard({ track, onOpen }: { track: Track; onOpen: () => void }) {
  const { src, loaded, onLoad, onError } = useCardArt(track.artwork);
  const idle = !loaded || undefined;
  return (
    <TrackMenu track={track}>
      <button type="button" className="trackCard" onClick={onOpen}>
        <img className="trackCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
        <span className="trackCardTitle" data-loading={idle}>{loaded ? track.title : NBSP}</span>
        <span className="trackCardArtist" data-loading={idle}>{loaded ? track.artist : NBSP}</span>
      </button>
    </TrackMenu>
  );
}

/** An album card: cover over the album name and artist. Jump-back-in wears it. */
export function AlbumCard({
  track,
  tracks,
  onOpen,
  onPlay,
  onOpenArtist,
}: {
  track: Track;
  /** The whole record, for the menu's Play/Shuffle/queue verbs. */
  tracks: Track[];
  onOpen: () => void;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist?: (artist: string) => void;
}) {
  const { src, loaded, onLoad, onError } = useCardArt(track.artwork);
  const idle = !loaded || undefined;
  return (
    <AlbumMenu
      tracks={tracks}
      onPlay={onPlay}
      onOpenArtist={onOpenArtist}
      artistName={track.albumArtist || track.artist}
    >
      <button type="button" className="trackCard" onClick={onOpen}>
        <img className="trackCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
        <span className="trackCardTitle" data-loading={idle}>{loaded ? track.album || track.title : NBSP}</span>
        <span className="trackCardArtist" data-loading={idle}>{loaded ? track.artist : NBSP}</span>
      </button>
    </AlbumMenu>
  );
}

/** An artist card: a round cover over the name, linking into the artist page. */
export function ArtistCard({ name, cover, onOpen }: { name: string; cover: string | null; onOpen: () => void }) {
  const { src, loaded, onLoad, onError } = useCardArt(cover);
  const idle = !loaded || undefined;
  return (
    <button type="button" className="artistCard" onClick={onOpen}>
      <img className="artistCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
      <span className="artistCardName" data-loading={idle}>{loaded ? name : NBSP}</span>
    </button>
  );
}

/** A mix's cover: the generated object its name earns (a decade, a mood, a
 *  genre - or the curator's own faces for AI-made lists), else the 2x2
 *  mosaic of its first artworks, glyph fallback. */
export function MixCover({ tracks, art }: { tracks: Track[]; art?: { src: string; hue: number } | null }) {
  // A served object that fails to arrive (old server, missing piece) steps
  // the cover back down to the mosaic rather than leaving a broken image.
  const [dead, setDead] = useState(false);
  const object = !dead && art ? art : null;
  const arts = mosaicArts(tracks.map((t) => t.artwork));
  // Under four covers the glyph stands in, and a glyph never loads - the tile
  // hook watches exactly the urls the grid below will draw.
  const { loaded, hostRef } = useTileArt(object || arts.length < 4 ? [] : arts);
  const served = useArtLoad(object?.src ?? null, '');
  if (object) {
    return (
      <div
        className="mixCardCover mixCardCover--object"
        aria-hidden
        style={
          {
            '--mixHue': `${object.hue}`,
            '--objectArt': `url("${object.src}")`,
          } as React.CSSProperties
        }
      >
        <img
          {...served}
          src={object.src}
          alt=""
          loading="lazy"
          onError={() => {
            served.onError();
            setDead(true);
          }}
        />
      </div>
    );
  }
  if (arts.length < 4) {
    return (
      <div className="mixCardCover mixCardCover--glyph" aria-hidden>
        <Sparkles size={28} />
      </div>
    );
  }
  return (
    <div ref={hostRef} className="mixCardCover" aria-hidden data-tile-pop="" data-tile-loading={!loaded || undefined}>
      {arts.map((art, i) => (
        <img key={i} src={art} alt="" loading="lazy" />
      ))}
    </div>
  );
}

export interface ResolvedMix {
  id: string;
  title: string;
  blurb: string;
  flavor: 'ai' | 'heuristic';
  tracks: Track[];
}

/** The object a mix's name earns - its URL and the hue of the ground it sits
 *  on - or null when the mix keeps its track mosaic. */
export function mixArt(
  title: string,
  opts: { id: string; curated?: boolean; flavor?: 'ai' | 'heuristic' },
): { src: string; hue: number } | null {
  const slug = mixArtwork(title, opts);
  return slug ? { src: artworkUrl(slug), hue: artworkHue(slug) } : null;
}

/** A shelf: a heading and a horizontal run of cards. Renders nothing when
 * it has nothing - an empty rail is clutter, not information. A shelf can
 * carry one action on the heading's right - a door related to what the rail
 * shows, sitting where the eye finishes reading the title. */
export function Shelf({ title, children, count, action }: { title: string; children: React.ReactNode; count: number; action?: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <section className="homeShelf">
      {action ? (
        <div className="homeShelfHead">
          <h2 className="homeShelfTitle">{title}</h2>
          {action}
        </div>
      ) : (
        <h2 className="homeShelfTitle">{title}</h2>
      )}
      <ScrollArea orientation="horizontal" className="homeShelfScroll" hideScrollbar>
        <div className="homeShelfRow">{children}</div>
      </ScrollArea>
    </section>
  );
}
