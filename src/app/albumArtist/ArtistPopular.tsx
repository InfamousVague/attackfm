import { Check, Heart, ListPlus, Music, Play, Plus, X } from '@glacier/icons';
import { useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { AddToPlaylistDialog } from '../playlists/AddToPlaylist.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { artSized, type CatalogTrack, type ServerSession } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import type { Track } from '../core/tauri.ts';
import type { AddingState } from './artistAcquire.ts';
import type { PopularRow } from './artistData.ts';
import { formatClock } from '../ux/format.ts';

/** A popular row's thumbnail: the same treatment at list size. */
function CatalogArt({ src }: { src: string }) {
  const sized = artSized(src, 160) ?? src;
  const art = useArtLoad(sized, 'catalogTrack__art');
  return <img {...art} src={sized} alt="" loading="lazy" />;
}

interface ArtistPopularProps {
  popular: PopularRow[];
  adding: AddingState;
  addSong: (t: CatalogTrack) => Promise<void>;
  /** Love a catalogue song: download it and promise the like. */
  loveSong: (t: CatalogTrack) => void;
  /** Track ids loved this session, for the heart's filled state. */
  loved: Set<string>;
  /** How many times this listener has played a track of theirs, or null when
   *  the server has no count for it (signed out, older server, never played). */
  playsFor: (path: string) => number | null;
  theirs: Track[];
  session: ServerSession | null;
  onPlay: (track: Track, queue: Track[]) => void;
}

/** The Popular shelf: the catalogue's ranking of their best-known songs. */
export function ArtistPopular({
  popular,
  adding,
  addSong,
  loveSong,
  loved,
  playsFor,
  theirs,
  session,
  onPlay,
}: ArtistPopularProps) {
  const { isFavorite, toggleFavorite } = useLibrary();
  // The song a visible "add to playlist" tap is filing, for the sheet.
  const [filing, setFiling] = useState<Track | null>(null);
  if (popular.length === 0) return null;
  return (
    <section className="homeShelf">
      <h2 className="homeShelfTitle">Popular</h2>
      {/* The artist's best-known songs as the CATALOGUE ranks them, not as
          your own shelf does. This used to be a list of your play counts,
          which meant an artist you owned two songs by had a "top songs" of
          exactly those two - a chart of one listener is not a chart. Your
          counts survive as a line on the rows you do own. A song you have
          plays; the rest are one tap from your downloads. */}
      <ol className="catalogTracks">
        {popular.map((t, index) => {
          const state = adding[t.id];
          const mine = t.mine;
          const plays = mine ? playsFor(mine.path) : null;
          // A row you OWN is a song and wears the song menu; a row that is
          // still only in the catalogue is an offer, and there is nothing
          // to queue or file yet.
          const row = (
            <li key={t.id} className="catalogTrack">
              <span className="catalogTrack__rank">{index + 1}</span>
              {t.cover ? (
                <CatalogArt src={t.cover} />
              ) : (
                <span className="catalogTrack__art catalogTrack__art--glyph" aria-hidden>
                  <Music size={16} />
                </span>
              )}
              {/* Owning it makes the row a play button; otherwise the title
                  is a label and the only control is the add. */}
              {mine ? (
                <button
                  type="button"
                  className="catalogTrack__title catalogTrack__title--play"
                  onClick={() => onPlay(mine, theirs)}
                >
                  {t.title}
                </button>
              ) : (
                <span className="catalogTrack__title">{t.title}</span>
              )}
              {/* Your own count, where the server has one - the part of the
                  old shelf worth keeping. */}
              {plays !== null && (
                <span className="catalogTrack__plays">
                  {plays.toLocaleString()} {plays === 1 ? 'play' : 'plays'}
                </span>
              )}
              <span className="catalogTrack__time">{formatClock(t.duration, '--:--')}</span>
              {/* Love it, wherever it is: an owned song toggles the heart in
                  the library; a catalogue song is loved AND pulled down, and
                  lands in Liked when the download arrives (see the incoming
                  band). The one control on every row the listener asked for. */}
              {mine ? (
                <button
                  type="button"
                  className="catalogTrack__love"
                  aria-label={isFavorite(mine.path) ? `Remove ${t.title} from Liked` : `Love ${t.title}`}
                  aria-pressed={isFavorite(mine.path)}
                  onClick={() => toggleFavorite(mine.path)}
                >
                  <Heart size={15} fill={isFavorite(mine.path) ? 'currentColor' : 'none'} />
                </button>
              ) : t.catalogue ? (
                <button
                  type="button"
                  className="catalogTrack__love"
                  aria-label={loved.has(t.id) ? `${t.title} loved` : `Love ${t.title}`}
                  aria-pressed={loved.has(t.id)}
                  disabled={!session}
                  onClick={() => loveSong(t.catalogue!)}
                >
                  <Heart size={15} fill={loved.has(t.id) ? 'currentColor' : 'none'} />
                </button>
              ) : null}
              {/* Add to a playlist - only a song you actually have can be
                  filed; a catalogue row loves-and-downloads first. */}
              {mine && (
                <button
                  type="button"
                  className="catalogTrack__love"
                  aria-label={`Add ${t.title} to a playlist`}
                  onClick={() => setFiling(mine)}
                >
                  <ListPlus size={15} />
                </button>
              )}
              {/* Nothing to add for a song you already have, and nothing to
                  add when this row came from your own library in the first
                  place (the catalogue was unreachable). */}
              {mine ? (
                /* The check is a control, not a label: a song you own is
                   one tap from playing wherever you tap it - the title or
                   the badge - and the badge says so by becoming a play on
                   hover. Before this it was decoration, so tapping the
                   obvious target did nothing at all. */
                <button
                  type="button"
                  className="catalogTrack__add"
                  data-state="owned"
                  aria-label={`Play ${t.title}`}
                  onClick={() => onPlay(mine, theirs)}
                >
                  <Check size={14} className="catalogTrack__have" />
                  <Play size={14} className="catalogTrack__go" />
                </button>
              ) : !t.catalogue ? (
                <span className="catalogTrack__add" data-state="added" aria-hidden>
                  <Check size={14} />
                </span>
              ) : (
                <button
                  type="button"
                  className="catalogTrack__add"
                  data-state={
                    state === 'added'
                      ? 'added'
                      : state === 'missing'
                        ? 'missing'
                        : state === 'finding'
                          ? 'adding'
                          : 'idle'
                  }
                  disabled={state !== undefined || !session}
                  aria-label={
                    state === 'missing' ? `${t.title} is not on Spotify` : `Add ${t.title}`
                  }
                  title={
                    state === 'missing' ? `${t.title} is not on Spotify to import` : undefined
                  }
                  onClick={() => void addSong(t.catalogue!)}
                >
                  {state === 'added' ? (
                    <Check size={14} />
                  ) : state === 'finding' ? (
                    <span className="artistAlbumSpin" aria-label="Finding it on Spotify" />
                  ) : state === 'missing' ? (
                    <X size={14} />
                  ) : (
                    <Plus size={14} />
                  )}
                </button>
              )}
            </li>
          );
          return mine ? (
            <TrackMenu key={t.id} track={mine} className="catalogTrackMenu">
              {row}
            </TrackMenu>
          ) : (
            row
          );
        })}
      </ol>
      <AddToPlaylistDialog track={filing} open={filing !== null} onClose={() => setFiling(null)} />
    </section>
  );
}
