import { ArtistLink } from '../ux/ArtistLink.tsx';
import { BookAudio, Check, ChevronRight, Disc3, Heart, ListEnd, ListMusic, ListStart, Music, Play, Plus, Tag, User, Users, X } from '@glacier/icons';
import type { ReactNode } from 'react';
import { AlbumMenu } from '../albumArtist/AlbumMenu.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { CatalogTrackMenu } from '../library/CatalogTrackMenu.tsx';
import type { QueueControls } from '../player/queueControls.tsx';
import type { AcquireValue } from '../../plugins/runtime.tsx';
import { PROBE_URL } from './resolveImport.ts';
import { coversOf, kindWord, targetOf, type Item } from './searchModel.tsx';
import { Glyph, SongSub } from './SearchBits.tsx';
import type { AddingState } from './useCatalogSearch.ts';
import type { Track } from '../core/tauri.ts';

/** Everything a row needs from the page: the cursor seat, the verbs, and the
 *  live state its trailing edge reflects. Built plain per render by SearchPage. */
export interface RowCtx {
  position: Map<string, number>;
  cursor: number;
  setCursor: (n: number) => void;
  open: (item: Item) => void;
  /** Like a catalogue song and pull it down, without touching now-playing. */
  like: (item: Item) => void;
  queue: QueueControls;
  adding: AddingState;
  acquire: AcquireValue;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Love a song already in the library, straight from its row. */
  favorite: { is: (path: string) => boolean; toggle: (path: string) => void };
  query: string;
  tracks: readonly Track[];
}

/** Rendered as a plain call rather than a component, so a keystroke does not
 *  replace every row's element type - which would drop the open context menu
 *  and reset each row on every letter. */
export const renderRow = (item: Item, ctx: RowCtx): ReactNode => {
  const { position, cursor, setCursor, open, like, queue, adding, acquire, onPlay, onOpenArtist, favorite, query, tracks } = ctx;
  const n = position.get(item.id);
  const active = n !== undefined && n === cursor;
  const seat = {
    id: n === undefined ? undefined : `searchHit-${n}`,
    className: 'searchRow',
    role: 'option' as const,
    'aria-selected': active,
    'data-active': active || undefined,
    // The pointer drives the same cursor, so the highlight is never in two
    // places at once.
    onMouseEnter: () => n !== undefined && setCursor(n),
  };

  switch (item.t) {
    case 'action':
      return (
        <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
          <Glyph shape="square" fallback={<Plus size={18} />} />
          <span className="searchRow__text">
            <span className="searchRow__title">{item.label}</span>
            {item.group && <span className="searchRow__sub">{item.group}</span>}
          </span>
          <ChevronRight size={16} className="searchRow__end" />
        </button>
      );

    case 'song':
      return (
        // Long-press or right-click for the same menu every song in the app
        // carries; the two verbs are also spelled out on hover, and on Q/N.
        <TrackMenu key={item.id} track={item.track}>
          <div className="searchRowSeat">
            <button type="button" {...seat} onClick={() => open(item)}>
              <Glyph shape="square" cover={item.track.artwork} fallback={<Music size={18} />} />
              <span className="searchRow__text">
                <span className="searchRow__title">{item.track.title}</span>
                <SongSub track={item.track} why={item.why} query={query} />
              </span>
            </button>
            <span className="searchRow__verbs">
              <button
                type="button"
                className="searchVerb searchVerb--heart"
                title={favorite.is(item.track.path) ? 'Loved' : 'Love this song'}
                aria-label={
                  favorite.is(item.track.path)
                    ? `Remove ${item.track.title} from Liked`
                    : `Love ${item.track.title}`
                }
                aria-pressed={favorite.is(item.track.path)}
                onClick={() => favorite.toggle(item.track.path)}
              >
                <Heart size={15} fill={favorite.is(item.track.path) ? 'currentColor' : 'none'} />
              </button>
              <button
                type="button"
                className="searchVerb"
                title="Play next (N)"
                aria-label={`Play ${item.track.title} next`}
                onClick={() => queue.playNext(item.track)}
              >
                <ListStart size={15} />
              </button>
              <button
                type="button"
                className="searchVerb"
                title="Add to queue (Q)"
                aria-label={`Add ${item.track.title} to the queue`}
                onClick={() => queue.addToQueue(item.track)}
              >
                <ListEnd size={15} />
              </button>
            </span>
          </div>
        </TrackMenu>
      );

    case 'artist':
      return (
        <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
          <Glyph shape="circle" cover={item.artist.cover} fallback={<User size={18} />} />
          <span className="searchRow__text">
            <span className="searchRow__title">{item.artist.name}</span>
            <span className="searchRow__sub">
              Artist · {item.artist.count === 1 ? '1 song' : `${item.artist.count} songs`}
            </span>
          </span>
          <ChevronRight size={16} className="searchRow__end" />
        </button>
      );

    case 'book':
      return (
        <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
          <Glyph shape="square" cover={item.book.cover} fallback={<BookAudio size={18} />} />
          <span className="searchRow__text">
            <span className="searchRow__title">{item.book.title}</span>
            <span className="searchRow__sub">
              {/* The author is NOT an ArtistLink. That door opens an artist page
                  - other records, top songs - which is built for a musician and
                  would hold one book. */}
              Book &middot; {item.book.author} &middot;{' '}
              {item.book.chapters.length === 1
                ? '1 chapter'
                : `${item.book.chapters.length} chapters`}
            </span>
          </span>
          <Play size={16} className="searchRow__end" />
        </button>
      );

    case 'album':
      return (
        <AlbumMenu
          key={item.id}
          tracks={item.album.tracks}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          artistName={item.album.artist}
        >
          <button type="button" {...seat} onClick={() => open(item)}>
            <Glyph shape="square" cover={item.album.cover} fallback={<Disc3 size={18} />} />
            <span className="searchRow__text">
              <span className="searchRow__title">{item.album.title}</span>
              <span className="searchRow__sub">
                Album · <ArtistLink artist={item.album.artist} /> ·{' '}
                {item.album.count === 1 ? '1 song' : `${item.album.count} songs`}
              </span>
            </span>
            <Play size={16} className="searchRow__end" />
          </button>
        </AlbumMenu>
      );

    case 'playlist':
      return (
        <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
          <Glyph
            shape="mosaic"
            covers={coversOf(item.playlist, tracks)}
            fallback={<ListMusic size={18} />}
          />
          <span className="searchRow__text">
            <span className="searchRow__title">{item.playlist.name}</span>
            <span className="searchRow__sub">
              Playlist ·{' '}
              {item.playlist.paths.length === 1
                ? '1 song'
                : `${item.playlist.paths.length} songs`}
            </span>
          </span>
          <ChevronRight size={16} className="searchRow__end" />
        </button>
      );

    case 'genre':
      return (
        <button key={item.id} type="button" {...seat} onClick={() => open(item)}>
          <Glyph shape="tile" tint={item.genre.name} fallback={<Tag size={18} />} />
          <span className="searchRow__text">
            <span className="searchRow__title">{item.genre.name}</span>
            <span className="searchRow__sub">
              Genre · {item.genre.count === 1 ? '1 song' : `${item.genre.count} songs`}
            </span>
          </span>
          <ChevronRight size={16} className="searchRow__end" />
        </button>
      );

    case 'friend':
      return (
        <div key={item.id} className="searchRow" data-static>
          <Glyph shape="circle" fallback={<Users size={18} />} />
          <span className="searchRow__text">
            <span className="searchRow__title">@{item.friend.handle}</span>
            <span className="searchRow__sub">
              Friend
              {item.friend.songs > 0 ? ` · ${item.friend.songs.toLocaleString()} songs` : ''}
            </span>
          </span>
        </div>
      );

    case 'catalog': {
      const state = adding[item.result.id];
      // An artist row is a door; a track or album is an Add, live whenever
      // anything could take a link - the tap finds a usable one if this row's
      // own link is not (a Deezer album, say).
      const isArtist = item.result.kind === 'artist';
      const can =
        !isArtist &&
        acquire.hasHandlers({ ...targetOf(item.result), url: PROBE_URL }) &&
        state !== 'missing';
      const have = item.mine !== null;
      const inside = (
        <>
          <Glyph
            shape={item.result.kind === 'artist' ? 'circle' : 'square'}
            cover={item.result.cover}
            fallback={
              item.result.kind === 'artist' ? (
                <User size={18} />
              ) : item.result.kind === 'album' ? (
                <Disc3 size={18} />
              ) : (
                <Music size={18} />
              )
            }
          />
          <span className="searchRow__text">
            <span className="searchRow__title">{item.result.title}</span>
            <span className="searchRow__sub">
              {/* An artist row's subtitle from the server is the word
                  "Artist" itself, so saying the kind twice is all it would
                  ever do; say where it leads instead. */}
              {isArtist ? (
                'Artist · not in your library'
              ) : item.result.kind === 'track' || item.result.kind === 'album' ? (
                // The catalogue's subtitle for a song or a record IS the
                // artist's name, so it opens like one.
                <>
                  {kindWord(item.result.kind)} · <ArtistLink artist={item.result.subtitle} />
                </>
              ) : (
                `${kindWord(item.result.kind)} · ${item.result.subtitle}`
              )}
              {item.result.source && (
                <span className={`searchSource searchSource--${item.result.source}`}>
                  {item.result.source === 'deezer' ? 'Deezer' : 'Spotify'}
                </span>
              )}
            </span>
          </span>
        </>
      );
      if (!isArtist && !can && state === undefined) {
        return (
          <div key={item.id} className="searchRow" data-static>
            {inside}
            {have && <Check size={16} className="searchRow__end" data-ok />}
          </div>
        );
      }
      const row = (
        <button key={isArtist ? item.id : undefined} type="button" {...seat} onClick={() => open(item)}>
          {inside}
          {isArtist ? (
            <ChevronRight size={16} className="searchRow__end" />
          ) : have || state === 'added' || state === 'liked' ? (
            <Check size={16} className="searchRow__end" data-ok />
          ) : state === 'finding' ? (
            <span className="searchAdd" data-busy>
              <span className="artistAlbumSpin" aria-hidden /> Finding
            </span>
          ) : state === 'missing' ? (
            <span className="searchAdd" data-missing>
              <X size={14} /> Not on Spotify
            </span>
          ) : (
            <span className="searchAdd">
              <Plus size={14} /> Add
            </span>
          )}
        </button>
      );
      // A song you can pull down is a song you can LIKE before it lands: the
      // heart queues the same download and promises the favourite, so it
      // walks straight into Liked while it is still on the wire. Always
      // visible - this verb exists for a thumb, not a hovering pointer.
      if (!isArtist && item.result.kind === 'track' && can && !have) {
        const liked = state === 'liked';
        // Long-press for the not-owned menu, whose reason to exist is "file
        // this into a playlist to acquire". Add and Love are the same acts as
        // the tap and the heart, offered to the thumb that held the row.
        return (
          <CatalogTrackMenu
            key={item.id}
            target={{ artist: item.result.subtitle, title: item.result.title, url: item.result.url }}
            onAdd={() => open(item)}
            onLike={() => like(item)}
            liked={liked}
          >
            <div className="searchRowSeat searchRowSeat--slim">
              {row}
              <span className="searchRow__verbs" data-always>
                <button
                  type="button"
                  className="searchVerb searchVerb--heart"
                  title="Like and download"
                  aria-label={`Like ${item.result.title} and download it`}
                  aria-pressed={liked}
                  onClick={() => like(item)}
                >
                  <Heart size={15} fill={liked ? 'currentColor' : 'none'} />
                </button>
              </span>
            </div>
          </CatalogTrackMenu>
        );
      }
      return row;
    }

    default: {
      /* A kind with no row here renders NOTHING, in silence - which is what
         happened while books were being added: this switch is not exhaustive by
         itself, so the compiler was perfectly happy with a blank space where a
         result should be. This makes the next one a build error instead. */
      const unreachable: never = item;
      void unreachable;
      return null;
    }
  }
};
