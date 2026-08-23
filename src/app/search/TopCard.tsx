import { ArtistLink } from '../ux/ArtistLink.tsx';
import { ChevronRight, Disc3, ListMusic, Music, Play, User } from '@glacier/icons';
import { mosaicArts, useArtLoad, useTileArt } from '../ux/artLoad.ts';
import { artSized } from '../server.ts';
import { coversOf, type Item } from './searchModel.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * The Top result, as a card rather than a row: big art, what it is, and the one
 * verb that matters for its kind. It is the answer the page is most confident
 * about, so it gets the room to look like one.
 */
export function TopCard({
  item,
  tracks,
  id,
  active,
  onOpen,
  onHover,
}: {
  item: Item;
  tracks: readonly Track[];
  id?: string;
  active: boolean;
  onOpen: () => void;
  onHover: () => void;
}) {
  const face = (() => {
    switch (item.t) {
      case 'artist':
        return {
          shape: 'circle' as const,
          cover: item.artist.cover,
          fallback: <User size={34} />,
          title: item.artist.name,
          sub: `Artist · ${item.artist.count === 1 ? '1 song' : `${item.artist.count} songs`}`,
          play: false,
        };
      case 'album':
        return {
          shape: 'square' as const,
          cover: item.album.cover,
          fallback: <Disc3 size={34} />,
          title: item.album.title,
          sub: (
            <>
              Album · <ArtistLink artist={item.album.artist} />
            </>
          ),
          play: true,
        };
      case 'song':
        return {
          shape: 'square' as const,
          cover: item.track.artwork,
          fallback: <Music size={34} />,
          title: item.track.title,
          sub: (
            <>
              Song · <ArtistLink artist={item.track.artist} />
            </>
          ),
          play: true,
        };
      case 'playlist':
        return {
          shape: 'mosaic' as const,
          cover: null,
          fallback: <ListMusic size={34} />,
          title: item.playlist.name,
          sub: `Playlist · ${item.playlist.paths.length} songs`,
          play: false,
        };
      // A catalogue artist can lead the page when the library holds nothing
      // by them - the same card, saying plainly that this one is a door out
      // to their catalogue rather than a shelf of yours.
      case 'catalog':
        return item.result.kind === 'artist'
          ? {
              shape: 'circle' as const,
              cover: item.result.cover,
              fallback: <User size={34} />,
              title: item.result.title,
              sub: 'Artist · not in your library',
              play: false,
            }
          : null;
      default:
        return null;
    }
  })();
  // Hooks sit before the null gate: React needs them called on every render,
  // whatever kind this card resolves to. The hero cover is big, so 640.
  const mosaic = item.t === 'playlist' ? mosaicArts(coversOf(item.playlist, tracks)) : [];
  const { loaded: tiled, hostRef: tileRef } = useTileArt(mosaic);
  const sized = artSized(face?.cover ?? null, 640);
  const art = useArtLoad(sized, '');
  if (!face) return null;

  return (
    <button
      type="button"
      id={id}
      role="option"
      aria-selected={active}
      className="searchTopCard"
      data-active={active || undefined}
      onMouseEnter={onHover}
      onClick={onOpen}
    >
      <span className="searchTopCard__art" data-shape={face.shape}>
        {mosaic.length > 0 ? (
          <span
            ref={tileRef}
            className="searchMosaic"
            data-n={mosaic.length}
            data-tile-pop=""
            data-tile-loading={!tiled || undefined}
          >
            {mosaic.map((c, i) => (
              <img key={`${c}:${i}`} src={c} alt="" loading="lazy" />
            ))}
          </span>
        ) : sized ? (
          <img {...art} src={sized} alt="" loading="lazy" />
        ) : (
          face.fallback
        )}
      </span>
      <span className="searchTopCard__title">{face.title}</span>
      <span className="searchTopCard__sub">{face.sub}</span>
      <span className="searchTopCard__verb">
        {face.play ? <Play size={15} /> : <ChevronRight size={15} />}
        {face.play ? 'Play' : 'Open'}
      </span>
    </button>
  );
}
