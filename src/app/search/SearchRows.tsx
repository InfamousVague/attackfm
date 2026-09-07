import { ArtistLink } from '../ux/ArtistLink.tsx';
import { BookAudio, Check, ChevronRight, Disc3, ListEnd, ListMusic, ListStart, Music, Play, Plus, Tag, User, Users, X } from '@glacier/icons';
import type { ReactNode } from 'react';
import { AlbumMenu } from '../albumArtist/AlbumMenu.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { CatalogTrackMenu } from '../library/CatalogTrackMenu.tsx';
import type { QueueControls } from '../player/queueControls.tsx';
import type { AcquireValue } from '../../plugins/runtime.tsx';
import { PROBE_URL } from './resolveImport.ts';
import { coversOf, kindWordKey, targetOf, type Item } from './searchModel.tsx';
import { Glyph, SongSub } from './SearchBits.tsx';
import type { AddingState } from './useCatalogSearch.ts';
import type { Track } from '../core/tauri.ts';

/** Where a catalogue row came from. Brand names, so they are the same word in
 *  every language and stay out of the catalogue. */
const SOURCE_NAME: Record<string, string> = { deezer: 'Deezer', spotify: 'Spotify' };

/** Everything a row needs from the page: the cursor seat, the verbs, and the
 *  live state its trailing edge reflects. Built plain per render by SearchPage. */
export interface RowCtx {
  /* The row renderer is a plain call, so it cannot hold hooks of its own -
     the page's translator and song counter travel in the seat with everything
     else it needs, which also keeps every row on the SAME render's language. */
  t: (key: string, options?: Record<string, unknown>) => string;
  songs: (n: number) => string;
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
  query: string;
  tracks: readonly Track[];
}

/** Rendered as a plain call rather than a component, so a keystroke does not
 *  replace every row's element type - which would drop the open context menu
 *  and reset each row on every letter. */
export const renderRow = (item: Item, ctx: RowCtx): ReactNode => {
  const { t, songs, position, cursor, setCursor, open, like, queue, adding, acquire, onPlay, onOpenArtist, query, tracks } = ctx;
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
            {/* The heart used to lead this row and it lives in the menu now
                (TrackMenu carries Love, and Add to playlist beside it). The
                two that stayed are the queue verbs, which are hover
                affordances with keys of their own - Q and N - rather than a
                third control competing for a thumb. */}
            <span className="searchRow__verbs">
              <button
                type="button"
                className="searchVerb"
                title={t('search.playNextHint')}
                aria-label={t('search.playNextOf', { title: item.track.title })}
                onClick={() => queue.playNext(item.track)}
              >
                <ListStart size={15} />
              </button>
              <button
                type="button"
                className="searchVerb"
                title={t('search.queueHint')}
                aria-label={t('search.queueOf', { title: item.track.title })}
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
              {t('search.kindArtist')} · {songs(item.artist.count)}
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
              {t('search.kindBook')} · {item.book.author} ·{' '}
              {t('books.chapterCount', { count: item.book.chapters.length })}
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
                {t('search.kindAlbum')} · <ArtistLink artist={item.album.artist} /> ·{' '}
                {songs(item.album.count)}
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
              {t('search.kindPlaylist')} · {songs(item.playlist.paths.length)}
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
              {t('search.kindGenre')} · {songs(item.genre.count)}
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
              {t('search.kindFriend')}
              {item.friend.songs > 0 ? ` · ${songs(item.friend.songs)}` : ''}
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
                t('search.artistNotInLibrary')
              ) : item.result.kind === 'track' || item.result.kind === 'album' ? (
                // The catalogue's subtitle for a song or a record IS the
                // artist's name, so it opens like one.
                <>
                  {t(kindWordKey(item.result.kind))} · <ArtistLink artist={item.result.subtitle} />
                </>
              ) : (
                `${t(kindWordKey(item.result.kind))} · ${item.result.subtitle}`
              )}
              {item.result.source && (
                <span className={`searchSource searchSource--${item.result.source}`}>
                  {SOURCE_NAME[item.result.source] ?? item.result.source}
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
              <span className="artistAlbumSpin" aria-hidden /> {t('search.finding')}
            </span>
          ) : state === 'missing' ? (
            <span className="searchAdd" data-missing>
              <X size={14} /> {t('search.notOnSpotify')}
            </span>
          ) : (
            <span className="searchAdd">
              <Plus size={14} /> {t('search.add')}
            </span>
          )}
        </button>
      );
      // A song you can pull down is a song you can LIKE before it lands: the
      // like queues the same download and promises the favourite, so it walks
      // straight into Liked while it is still on the wire. That heart was a
      // button on the row - deliberately, for a thumb rather than a hovering
      // pointer - and it is in the long-press menu now with the rest of a
      // song's verbs, because a row carrying a title, an artist and its own
      // tap-to-add did not have the width for a fourth thing to aim at. The
      // tap on the row still adds; the hold is where liking and filing live.
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
            <div className="searchRowSeat searchRowSeat--slim">{row}</div>
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
