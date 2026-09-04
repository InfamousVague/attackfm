import { ScrollArea } from '@glacier/react';
import { Sparkles } from '@glacier/icons';
import { useState } from 'react';
import { mosaicArts, useArtLoad, useCardArt, useTileArt } from '../ux/artLoad.ts';
import { artworkHue, artworkUrl, cardTexture, mixArtwork } from '../ux/artwork.ts';
import type { Track } from '../core/tauri.ts';
import { AlbumMenu } from '../albumArtist/AlbumMenu.tsx';
import { ArtistLink } from '../ux/ArtistLink.tsx';
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
export function TrackCard({
  track,
  onOpen,
  note,
}: {
  track: Track;
  onOpen: () => void;
  /** A third line under the artist - who finished it, why it is here. */
  note?: React.ReactNode;
}) {
  const { src, loaded, onLoad, onError } = useCardArt(track.artwork);
  const idle = !loaded || undefined;
  return (
    <TrackMenu track={track}>
      <button type="button" className="trackCard" onClick={onOpen}>
        <img className="trackCardArt artPop" src={src} alt="" loading="lazy" data-loading={idle} onLoad={onLoad} onError={onError} />
        <span className="trackCardTitle" data-loading={idle}>{loaded ? track.title : NBSP}</span>
        {/* The name is its own press: stopPropagation inside, so a tap on
            the artist goes to their page while the rest of the card plays. */}
        <span className="trackCardArtist" data-loading={idle}>
          {loaded ? <ArtistLink artist={track.artist} /> : NBSP}
        </span>
        {note !== undefined && (
          <span className="trackCardNote" data-loading={idle}>
            {loaded ? note : NBSP}
          </span>
        )}
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
        <span className="trackCardArtist" data-loading={idle}>
          {loaded ? <ArtistLink artist={track.artist} /> : NBSP}
        </span>
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

/** A mix's cover: the album art of the songs inside, exactly like a playlist's
 *  face - the 2x2 mosaic of the first four distinct covers. Only when there is
 *  no album art to show (fewer than four distinct covers) does the brutalist
 *  texture stand in, chosen by the mix's own hue so it stays stable. */
export function MixCover({ tracks, art }: { tracks: Track[]; art?: { src: string; hue: number } | null }) {
  const arts = mosaicArts(tracks.map((t) => t.artwork));
  const { loaded, hostRef } = useTileArt(arts);
  /*
   * Album art from the songs inside wins whenever there is ANY - the whole
   * point: a mix wears its music, not a generated stand-in.
   *
   * Any, rather than a full four. Requiring four meant a mix drawn from two
   * records showed a texture and no album art at all, while holding the very
   * covers it was made of - and a short mix is exactly the one whose two or
   * three sleeves say most about it. The count drives the layout instead: one
   * fills the frame, two split it, three give the first the tall half.
   */
  if (arts.length > 0) {
    return (
      <div
        ref={hostRef}
        className="mixCardCover"
        data-covers={arts.length}
        aria-hidden
        data-tile-pop=""
        data-tile-loading={!loaded || undefined}
      >
        {arts.map((a, i) => (
          <img key={i} src={a} alt="" loading="lazy" />
        ))}
      </div>
    );
  }
  // Nothing to mosaic: the brutalist texture is the fallback (retiring the old
  // glyph and the generated object). Keyed on the mix's hue so it never shuffles.
  const hue = art?.hue ?? artworkHue(tracks[0]?.path ?? 'mix');
  return (
    <div
      className="mixCardCover mixCardCover--object"
      aria-hidden
      style={{ '--cardTex': `url("${cardTexture(hue)}")` } as React.CSSProperties}
    />
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
