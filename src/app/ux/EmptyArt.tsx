import { useState, type CSSProperties } from 'react';
import { artworkHue, artworkUrl, emptyArtwork } from './artwork.ts';
import discoveryDark from '../../assets/empty/discovery-dark.png';
import discoveryLight from '../../assets/empty/discovery-light.png';
import downloadsSolo from '../../assets/empty/downloads.webp';
import friendsDark from '../../assets/empty/friends-dark.png';
import friendsLight from '../../assets/empty/friends-light.png';
import libraryDark from '../../assets/empty/library-dark.png';
import libraryLight from '../../assets/empty/library-light.png';
import likedSolo from '../../assets/empty/liked.webp';
import playlistSolo from '../../assets/empty/playlist.webp';
import searchSolo from '../../assets/empty/search.webp';

/**
 * The spot illustration each empty state opens on, so a page with nothing in it
 * still reads as designed rather than blank. Every motif ships as a light/dark
 * pair painted onto the exact page-background hex, so the seam disappears into
 * the page. Which one shows is pure CSS, mirroring the theme system in
 * appearance.tsx: no `data-theme` means follow the OS (`prefers-color-scheme`),
 * an explicit `data-theme` wins over it - so the picture never drifts out of
 * sync with the surface it sits on, no React theme state required.
 */
export type EmptyArtName =
  | 'discovery'
  | 'downloads'
  | 'friends'
  | 'library'
  | 'liked'
  | 'playlist'
  | 'search';

/**
 * A motif is either a PAINTED PAIR or a SOLO object.
 *
 * A painted pair is a picture with the page's background baked into it, one per
 * theme, which is why it needs two files and a CSS swap. A solo is a cut-out on
 * transparency: there is no background to match, so one file is right in both
 * themes and a second would be the same image twice.
 *
 * The distinction is not cosmetic - it decides whether the radial mask applies.
 * That mask exists to dissolve a painted image's residual box into the page; run
 * over a cut-out it fades the edges of the OBJECT instead, which on a wide one
 * (the sequencer is better than two to one) eats the ends.
 */
type Motif = { light: string; dark: string } | { solo: string };

const ART: Record<EmptyArtName, Motif> = {
  discovery: { light: discoveryLight, dark: discoveryDark },
  downloads: { solo: downloadsSolo },
  friends: { light: friendsLight, dark: friendsDark },
  library: { light: libraryLight, dark: libraryDark },
  liked: { solo: likedSolo },
  playlist: { solo: playlistSolo },
  search: { solo: searchSolo },
};

function isSolo(m: Motif): m is { solo: string } {
  return 'solo' in m;
}

/**
 * The same painted light/dark pair, but worn as a HERO that fills its box
 * rather than an empty-state spot dissolved into the page. No server-slug swap
 * (the whole point is the local art the owner made - e.g. the neon Liked heart)
 * and no radial mask: the picture covers the tile or cover it is dropped into,
 * edge to edge. Used for the standout Liked tile and the Liked/All page heroes.
 */
export function HeroArt({ name, className }: { name: EmptyArtName; className?: string }) {
  const art = ART[name];
  return (
    <div className={className ? `heroArt ${className}` : 'heroArt'} aria-hidden="true">
      {isSolo(art) ? (
        <img className="heroArt__img heroArt__img--solo" src={art.solo} alt="" loading="lazy" />
      ) : (
        <>
          <img className="heroArt__img heroArt__img--light" src={art.light} alt="" loading="lazy" />
          <img className="heroArt__img heroArt__img--dark" src={art.dark} alt="" loading="lazy" />
        </>
      )}
    </div>
  );
}

export function EmptyArt({ name, className }: { name: EmptyArtName; className?: string }) {
  const art = ART[name];
  // The main server's generated set replaces the painted pair - a frosted
  // object on a card instead of a page-blended wash. Any failure (offline,
  // missing piece) falls back to the pair, so this never costs an empty
  // state its picture.
  const [failed, setFailed] = useState(false);
  const slug = emptyArtwork(name);
  const served = slug && !failed ? artworkUrl(slug) : null;
  return (
    <div
      className={className ? `emptyArt ${className}` : 'emptyArt'}
      aria-hidden="true"
      style={slug ? ({ '--emptyArtHue': `${artworkHue(slug)}` } as CSSProperties) : undefined}
    >
      {served ? (
        <img
          className="emptyArt__img emptyArt__img--served"
          src={served}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : isSolo(art) ? (
        <img className="emptyArt__img emptyArt__img--solo" src={art.solo} alt="" loading="lazy" />
      ) : (
        <>
          <img className="emptyArt__img emptyArt__img--light" src={art.light} alt="" loading="lazy" />
          <img className="emptyArt__img emptyArt__img--dark" src={art.dark} alt="" loading="lazy" />
        </>
      )}
    </div>
  );
}
