import type { ComponentType } from 'react';
import { ArrowDownToLine, Compass, Heart, Library, ListMusic, Search, Users } from '@glacier/icons';
import likedSolo from '../../assets/empty/liked.webp';
import libraryDark from '../../assets/empty/library-dark.png';
import libraryLight from '../../assets/empty/library-light.png';

/**
 * What an empty state opens on.
 *
 * A large glyph, for now. The spot illustrations that were here - a painted
 * light/dark pair per motif, plus a server-generated set that replaced them
 * when the main library was reachable - are out of the app rather than merely
 * switched off, so the empty states are one plain thing everywhere instead of
 * a picture whose look depended on which server answered.
 *
 * The names are kept exactly as they were, so every call site reads the same
 * and putting the art back later is a change to this file alone.
 */
export type EmptyArtName =
  | 'discovery'
  | 'downloads'
  | 'friends'
  | 'library'
  | 'liked'
  | 'playlist'
  | 'search';

const ICON: Record<EmptyArtName, ComponentType<{ size?: number }>> = {
  discovery: Compass,
  downloads: ArrowDownToLine,
  friends: Users,
  library: Library,
  liked: Heart,
  playlist: ListMusic,
  search: Search,
};

export function EmptyArt({ name, className }: { name: EmptyArtName; className?: string }) {
  const Icon = ICON[name];
  return (
    <div className={className ? `emptyArt ${className}` : 'emptyArt'} aria-hidden="true">
      {/* Sized in CSS rather than here, so the one number lives beside the
          spacing it has to sit in. */}
      <Icon />
    </div>
  );
}

/**
 * The painted pair worn as a HERO - filling a tile or a page header rather
 * than dissolved into an empty page. A different job from EmptyArt and it
 * keeps its pictures: these are the standout Liked tile and the Liked/All
 * page headers, where the art IS the surface rather than a decoration on a
 * page that has nothing to say.
 *
 * Narrowed to the two motifs it actually receives. It used to accept any
 * EmptyArtName, which meant every motif's files had to stay imported for a
 * lookup that only ever asked for these - so the other five were carried in
 * the bundle to satisfy a type.
 */
export type HeroArtName = 'liked' | 'library';

const HERO: Record<HeroArtName, { light: string; dark: string } | { solo: string }> = {
  liked: { solo: likedSolo },
  library: { light: libraryLight, dark: libraryDark },
};

export function HeroArt({ name, className }: { name: HeroArtName; className?: string }) {
  const art = HERO[name];
  return (
    <div className={className ? `heroArt ${className}` : 'heroArt'} aria-hidden="true">
      {'solo' in art ? (
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
