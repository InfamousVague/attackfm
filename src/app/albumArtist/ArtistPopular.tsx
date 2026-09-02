import { Check, Headphones, Heart, ListPlus, Music, Play, Plus, X } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { AddToPlaylistDialog } from '../playlists/AddToPlaylist.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { CatalogTrackMenu } from '../library/CatalogTrackMenu.tsx';
import { artSized, type CatalogTrack, type ServerSession } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import type { Track } from '../core/tauri.ts';
import type { AddingState } from './artistAcquire.ts';
import type { ArtistAudition } from './artistAudition.ts';
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
  /** Whose page this is - the artist a not-owned row is filed under when it is
   *  added to a playlist (the want's key is this name folded with the title). */
  artist: string;
  adding: AddingState;
  addSong: (t: CatalogTrack) => Promise<void>;
  /** Love a catalogue song: download it and promise the like - or, with
   *  `download` false, promise it alone because it is already on its way. */
  loveSong: (t: CatalogTrack, download?: boolean) => void;
  /** Track ids loved this session, for the heart's filled state. */
  loved: Set<string>;
  /** How many times this listener has played a track of theirs, or null when
   *  the server has no count for it (signed out, older server, never played). */
  playsFor: (path: string) => number | null;
  theirs: Track[];
  session: ServerSession | null;
  onPlay: (track: Track, queue: Track[]) => void;
  /** Listen to a song you do not own: a temporary copy, fetched on tap and
   *  played when it lands. See artistAudition.ts. */
  audition: ArtistAudition;
}

/** The Popular shelf: the catalogue's ranking of their best-known songs. */
export function ArtistPopular({
  popular,
  artist,
  adding,
  addSong,
  loveSong,
  loved,
  playsFor,
  theirs,
  session,
  onPlay,
  audition,
}: ArtistPopularProps) {
  const { isFavorite, toggleFavorite } = useLibrary();
  // The song a visible "add to playlist" tap is filing, for the sheet.
  const [filing, setFiling] = useState<Track | null>(null);
  /*
   * A heart given while the copy was still on its way is a heart on the copy
   * once it lands: adopt it the moment it appears. Without this the row's
   * heart emptied on landing (the promise lives on the hub, the copy's own
   * favourite flag is not set until the sweep) and the band called the like
   * stalled. Each copy is kept once; the ref remembers which.
   */
  const kept = useRef(new Set<string>());
  useEffect(() => {
    for (const t of popular) {
      if (!t.catalogue || t.mine || !loved.has(t.id)) continue;
      const copy = audition.copyOf(t.catalogue);
      if (!copy || kept.current.has(copy.path) || isFavorite(copy.path)) continue;
      kept.current.add(copy.path);
      toggleFavorite(copy.path);
    }
  }, [popular, loved, audition, isFavorite, toggleFavorite]);
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
          // A song you do not own can still be HEARD when something can
          // fetch it: a temporary copy, on tap. Once a copy is here the row
          // plays it whatever the downloader is doing now. An owned row is
          // out of this entirely - its own controls already play it.
          const heard = t.catalogue && !mine ? audition.stateOf(t.catalogue) : 'idle';
          const copy = t.catalogue && !mine ? audition.copyOf(t.catalogue) : null;
          const canListen = t.catalogue !== null && !mine && (heard === 'ready' || audition.can);
          const word =
            heard === 'fetching'
              ? 'fetching…'
              : heard === 'missing'
                ? 'not found'
                : heard === 'unreachable'
                  ? 'try later'
                  : heard === 'refused'
                    ? 'library full'
                    : heard === 'held'
                      ? 'unavailable'
                      : heard === 'budget'
                        ? 'no room'
                        : heard === 'offline'
                          ? 'downloader off'
                          : heard === 'error'
                            ? 'try again'
                            : null;
          const said =
            heard === 'ready'
              ? `Listen to ${t.title}`
              : heard === 'fetching'
                ? `${t.title} is on its way`
                : heard === 'missing'
                  ? `${t.title} is not on Spotify`
                  : heard === 'unreachable'
                    ? `The catalogue could not be reached for ${t.title}`
                    : heard === 'refused'
                      ? `The library is full`
                      : heard === 'held'
                        ? `${t.title} is not available to fetch`
                        : heard === 'budget'
                          ? `The collector is out of room`
                          : heard === 'offline'
                            ? `The download box is not answering`
                            : heard === 'error'
                              ? `${t.title} could not be fetched`
                              : `Fetch a copy of ${t.title} to listen to`;
          // A row you OWN is a song and wears the song menu; a row that is
          // still only in the catalogue is an offer, and there is nothing
          // to queue or file yet.
          const row = (
            <li
              key={t.id}
              className="catalogTrack"
              data-fetching={heard === 'fetching' || undefined}
              data-listen={canListen || undefined}
            >
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
              ) : canListen ? (
                /* Not owned, but one tap from being heard: the tap asks for
                   a TEMPORARY copy, the bar under the row says it is on its
                   way, and it plays the moment it lands. Nothing is added by
                   this - a listen through or a heart does that, the same as
                   any audition. */
                <button
                  type="button"
                  className="catalogTrack__title catalogTrack__title--play catalogTrack__title--mark"
                  aria-label={said}
                  aria-busy={heard === 'fetching' || undefined}
                  /* Not `disabled`: that drops the focus a keyboard just put
                     here. The hook ignores a tap while it is fetching. */
                  aria-disabled={heard === 'fetching' || undefined}
                  onClick={() => audition.listen(t.catalogue!)}
                >
                  <span className="catalogTrack__titleText">{t.title}</span>
                  {heard === 'ready' && (
                    <Headphones size={12} className="catalogTrack__temp" aria-hidden />
                  )}
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
              {/* The time cell doubles as the word, so the bar is never the
                  only thing saying what the row is doing. */}
              <span className="catalogTrack__time" aria-live={canListen ? 'polite' : undefined}>
                {word ?? formatClock(t.duration, '--:--')}
              </span>
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
              ) : copy ? (
                /* A copy is here to listen to: the heart ADOPTS it - the
                   same act as on any audition - rather than fetching it
                   again through the importer's door. A heart given while it
                   was still on its way reads as kept the moment it lands (the
                   effect above the list makes it so). */
                <button
                  type="button"
                  className="catalogTrack__love"
                  aria-label={
                    isFavorite(copy.path) || loved.has(t.id) ? `Remove ${t.title} from Liked` : `Keep ${t.title}`
                  }
                  aria-pressed={isFavorite(copy.path) || loved.has(t.id)}
                  onClick={() => toggleFavorite(copy.path)}
                >
                  <Heart size={15} fill={isFavorite(copy.path) || loved.has(t.id) ? 'currentColor' : 'none'} />
                </button>
              ) : t.catalogue ? (
                <button
                  type="button"
                  className="catalogTrack__love"
                  aria-label={loved.has(t.id) ? `${t.title} loved` : `Love ${t.title}`}
                  aria-pressed={loved.has(t.id)}
                  disabled={!session}
                  /* On its way already: promise the heart, do not fetch twice. */
                  onClick={() => loveSong(t.catalogue!, heard !== 'fetching')}
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
              ) : copy ? (
                /* The copy plays from the badge too, the way an owned row's
                   does; adding it again would only file a duplicate. The
                   heart is what keeps it. */
                <button
                  type="button"
                  className="catalogTrack__add"
                  data-state="owned"
                  aria-label={`Listen to ${t.title}`}
                  onClick={() => onPlay(copy, [copy])}
                >
                  <Check size={14} className="catalogTrack__have" />
                  <Play size={14} className="catalogTrack__go" />
                </button>
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
                  /* Not while a copy is on its way: two doors, one song. */
                  disabled={state !== undefined || !session || heard === 'fetching'}
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
              {heard === 'fetching' && (
                <span
                  className="catalogTrack__bar"
                  role="progressbar"
                  aria-label="Downloading a copy to listen to"
                />
              )}
            </li>
          );
          return mine ? (
            <TrackMenu key={t.id} track={mine} className="catalogTrackMenu">
              {row}
            </TrackMenu>
          ) : t.catalogue ? (
            // A catalogue row gets its own long-press menu - the not-owned
            // twin, whose reason to exist is "file it into a playlist to
            // acquire". Add and Love are the same acts as the row's buttons.
            <CatalogTrackMenu
              key={t.id}
              target={{ artist, title: t.title, url: t.catalogue.url }}
              /* The same copy-aware acts as the row's own buttons: a landed
                 copy is kept, not fetched again; one on its way is only
                 promised. */
              onAdd={() => {
                // Keeping a kept copy again must not un-keep it.
                if (copy) {
                  if (!isFavorite(copy.path)) toggleFavorite(copy.path);
                } else if (heard !== 'fetching') {
                  void addSong(t.catalogue!);
                }
              }}
              onLike={() => {
                if (copy) toggleFavorite(copy.path);
                else loveSong(t.catalogue!, heard !== 'fetching');
              }}
              liked={copy ? isFavorite(copy.path) : loved.has(t.id)}
            >
              {row}
            </CatalogTrackMenu>
          ) : (
            row
          );
        })}
      </ol>
      <AddToPlaylistDialog track={filing} open={filing !== null} onClose={() => setFiling(null)} />
    </section>
  );
}
