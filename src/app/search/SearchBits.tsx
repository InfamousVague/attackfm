import { ArtistLink } from '../ux/ArtistLink.tsx';
import { ChevronRight, Quote } from '@glacier/icons';
import { useState, type ReactNode } from 'react';
import { artworkUrl, genreArtwork } from '../ux/artwork.ts';
import { artSized } from '../server.ts';
import { mosaicArts, useArtLoad, useTileArt } from '../ux/artLoad.ts';
import { lyricExcerpt, type Why } from './trackSearch.ts';
import { hueOf } from './searchModel.tsx';
import type { Track } from '../core/tauri.ts';

/* --------------------------------------------------------------------- bits */

/** A section's heading: its glyph, its name, how many it found, and - when it
 *  is showing fewer than it has - the way to see the rest. */
export function Heading({
  icon,
  children,
  count,
  onSeeAll,
}: {
  icon: ReactNode;
  children: ReactNode;
  count?: number;
  onSeeAll?: () => void;
}) {
  return (
    <h2 className="searchSection__title">
      <span className="searchSection__glyph" aria-hidden>
        {icon}
      </span>
      {children}
      {count !== undefined && <span className="searchSection__count">{count}</span>}
      {onSeeAll && (
        <button type="button" className="searchSeeAll" onClick={onSeeAll}>
          See all
          <ChevronRight size={14} />
        </button>
      )}
    </h2>
  );
}

/**
 * The artwork square, in the shape its kind wears everywhere else in the app:
 * people are round, songs and albums are squares, a playlist is a soft-cornered
 * mosaic of what is in it, and a genre is a tinted tile. Shape is how you tell
 * what a row IS before you have read a word of it, which is the entire point of
 * putting eight kinds of thing on one page.
 */
export function Glyph({
  shape,
  cover,
  covers,
  fallback,
  tint,
}: {
  shape: 'circle' | 'square' | 'mosaic' | 'tile';
  cover?: string | null;
  /** Up to four, for the mosaic. */
  covers?: readonly string[];
  fallback: ReactNode;
  /** Seeds the tile's gradient, so one genre keeps one colour. */
  tint?: string;
}) {
  // Both loaders run for every shape - a glyph can change face as results
  // refine, and the hook order has to survive that. A mosaic skeletons and
  // reveals as one artwork; a single cover is a row thumb, so the 160 variant.
  const four = shape === 'mosaic' ? mosaicArts(covers ?? []) : [];
  const { loaded: tiled, hostRef: tileRef } = useTileArt(four);
  const sized = shape === 'mosaic' || shape === 'tile' ? null : artSized(cover ?? null, 160);
  const art = useArtLoad(sized, '');
  // A genre with a generated object wears it over the gradient; the tint
  // stays beneath as the loading face and the fallback for unmapped genres -
  // and for a served object that fails to arrive.
  const [tileDead, setTileDead] = useState(false);
  const tileSlug = shape === 'tile' && tint ? genreArtwork(tint) : null;
  const tileSrc = tileSlug && !tileDead ? artworkUrl(tileSlug) : null;
  const tileLoad = useArtLoad(tileSrc, '');
  if (shape === 'mosaic') {
    return (
      <span className="searchRow__glyph" data-shape="mosaic">
        {four.length > 0 ? (
          <span
            ref={tileRef}
            className="searchMosaic"
            data-n={four.length}
            data-tile-pop=""
            data-tile-loading={!tiled || undefined}
          >
            {four.map((c, i) => (
              <img key={`${c}:${i}`} src={c} alt="" loading="lazy" />
            ))}
          </span>
        ) : (
          fallback
        )}
      </span>
    );
  }
  if (shape === 'tile') {
    return (
      <span className="searchRow__glyph" data-shape="tile" style={hueOf(tint ?? '')}>
        {tileSrc ? (
          <img
            {...tileLoad}
            src={tileSrc}
            alt=""
            loading="lazy"
            onError={() => {
              tileLoad.onError();
              setTileDead(true);
            }}
          />
        ) : (
          fallback
        )}
      </span>
    );
  }
  return (
    <span className="searchRow__glyph" data-shape={shape}>
      {sized ? <img {...art} src={sized} alt="" loading="lazy" /> : fallback}
    </span>
  );
}

/** A Browse tile's cover, split out of the map so each tile owns its own
 *  skeleton hook. Tiles are grid-sized, so the 640 variant. `raw` is a served
 *  generated object: no size variants, and it IS the tile face rather than
 *  the corner card the library cover plays. A served object that fails (an
 *  old server, a missing piece) steps down to the library cover rather than
 *  leaving a broken image on the tile. */
export function GenreArt({ src, raw, fallback }: { src: string; raw?: boolean; fallback?: string | null }) {
  const [dead, setDead] = useState(false);
  const object = raw && !dead;
  const active = raw && dead ? (fallback ?? null) : src;
  const sized = active === null ? null : object ? active : artSized(active, 640);
  const art = useArtLoad(sized, object ? 'searchGenre__objectArt' : 'searchGenre__art');
  if (sized === null) return null;
  return (
    <img
      {...art}
      src={sized}
      alt=""
      loading="lazy"
      onError={() => {
        art.onError();
        if (object) setDead(true);
      }}
    />
  );
}

/** What a song row says under its title: normally the artist, but when the
 *  match came from the lyrics, the line that matched - because "why is this
 *  here" is the question a lyric hit always raises. */
export function SongSub({ track, why, query }: { track: Track; why: Why; query: string }) {
  const line = why === 'lyrics' ? lyricExcerpt(track, query) : null;
  if (line) {
    return (
      <span className="searchRow__sub" data-lyric>
        <Quote size={11} aria-hidden />
        <span className="searchRow__lyric">{line}</span>
      </span>
    );
  }
  return (
    <span className="searchRow__sub">
      Song · <ArtistLink artist={track.artist} />
      {track.lossless && <span className="searchQuality">Lossless</span>}
    </span>
  );
}
