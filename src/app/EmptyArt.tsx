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

export function EmptyArt({ name, className }: { name: EmptyArtName; className?: string }) {
  const art = ART[name];
  return (
    <div className={className ? `emptyArt ${className}` : 'emptyArt'} aria-hidden="true">
      <img className="emptyArt__img emptyArt__img--light" src={art.light} alt="" loading="lazy" />
      <img className="emptyArt__img emptyArt__img--dark" src={art.dark} alt="" loading="lazy" />
    </div>
  );
}
