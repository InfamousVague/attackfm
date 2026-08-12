import { useState, type CSSProperties } from 'react';
import { artworkHue, artworkUrl, emptyArtwork } from './artwork.ts';
import discoveryDark from '../assets/empty/discovery-dark.png';
import discoveryLight from '../assets/empty/discovery-light.png';
import downloadsDark from '../assets/empty/downloads-dark.png';
import downloadsLight from '../assets/empty/downloads-light.png';
import friendsDark from '../assets/empty/friends-dark.png';
import friendsLight from '../assets/empty/friends-light.png';
import libraryDark from '../assets/empty/library-dark.png';
import libraryLight from '../assets/empty/library-light.png';
import likedDark from '../assets/empty/liked-dark.png';
import likedLight from '../assets/empty/liked-light.png';
import playlistDark from '../assets/empty/playlist-dark.png';
import playlistLight from '../assets/empty/playlist-light.png';
import searchDark from '../assets/empty/search-dark.png';
import searchLight from '../assets/empty/search-light.png';

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

const ART: Record<EmptyArtName, { light: string; dark: string }> = {
  discovery: { light: discoveryLight, dark: discoveryDark },
  downloads: { light: downloadsLight, dark: downloadsDark },
  friends: { light: friendsLight, dark: friendsDark },
  library: { light: libraryLight, dark: libraryDark },
  liked: { light: likedLight, dark: likedDark },
  playlist: { light: playlistLight, dark: playlistDark },
  search: { light: searchLight, dark: searchDark },
};

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
      <img className="heroArt__img heroArt__img--light" src={art.light} alt="" loading="lazy" />
      <img className="heroArt__img heroArt__img--dark" src={art.dark} alt="" loading="lazy" />
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
      ) : (
        <>
          <img className="emptyArt__img emptyArt__img--light" src={art.light} alt="" loading="lazy" />
          <img className="emptyArt__img emptyArt__img--dark" src={art.dark} alt="" loading="lazy" />
        </>
      )}
    </div>
  );
}
