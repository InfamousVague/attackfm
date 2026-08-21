import { Button, Text, useToast } from '@glacier/react';
import { ListMusic, Plus } from '@glacier/icons';
import { useMemo } from 'react';
import { mosaicArts, useArtLoad, useTileArt } from '../ux/artLoad.ts';
import { formatClock, formatTotal } from '../ux/format.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { RowArt } from './RowArt.tsx';
import { RowMain } from './RowMain.tsx';
import { CoverWall } from './CoverWall.tsx';
import { usePlaylists } from './playlists.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * A list somebody else made, opened as a page.
 *
 * Curator mixes and the lists plugins contribute used to open in a modal that
 * previewed their contents - a second, smaller way of drawing a playlist that
 * existed only because these lists have no id to route to. Two renderings of
 * the same idea is one too many: the sheet could not show a running order, its
 * rows behaved differently from the rows on the real page, and a list you were
 * reading sat on top of the library instead of beside it in the back stack.
 *
 * So this wears the playlist page's clothes - the same head, the same rows,
 * the same stylesheet - and is reached the same way, by pushing a detail onto
 * whichever tab you were in. What it is NOT is PlaylistPage with a read-only
 * flag threaded through it: that page is made of editing (rename, delete,
 * reorder, remove, suggestions), and a list you do not own can do none of it.
 * Sharing the look without sharing the machinery is the honest half.
 *
 * The one verb it has is ADD, where the page it mirrors has Play and Shuffle.
 * These lists are not yours and the curator's keeps regenerating underneath
 * you, so the useful thing to offer is a copy that stops moving and becomes a
 * playlist you can edit - fork-on-edit, made a button. Rows still play; it is
 * only the header that differs, because playing a mix never needed a copy.
 */
export function MixPage({
  title,
  tracks,
  emptyLabel,
  onPlay,
  onOpenArtist,
  onOpenPlaylist,
}: {
  title: string;
  tracks: Track[];
  /** What to say when the list resolved to nothing at all. */
  emptyLabel?: string;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Where the copy lands, so Add can walk you straight to it. */
  onOpenPlaylist?: (id: string) => void;
}) {
  const { create } = usePlaylists();
  const { toast } = useToast();

  // Four covers make the quadrant mosaic and load as one artwork, exactly as
  // the playlist head does - see mosaicArts.
  const covers = useMemo(() => mosaicArts(tracks.map((t) => t.artwork)), [tracks]);
  const { loaded: coversLoaded, hostRef: coversRef } = useTileArt(covers.length >= 4 ? covers : []);
  const singleCover = useArtLoad(covers.length >= 4 ? null : (covers[0] ?? null), '');
  const totalSeconds = useMemo(
    () => tracks.reduce((sum, t) => sum + (t.duration ?? 0), 0),
    [tracks],
  );

  const saveCopy = () => {
    if (tracks.length === 0) return;
    void create(
      title,
      tracks.map((t) => t.path),
    ).then((id) => {
      toast({
        message: `Saved “${title}” to your playlists`,
        // The copy is a real list now, so the toast can hand you to it rather
        // than leaving you on the page you copied FROM.
        action: id && onOpenPlaylist ? { label: 'Open', onPress: () => onOpenPlaylist(id) } : undefined,
      });
    });
  };

  return (
    /*
     * The same three classes the playlist page and the Liked page wear, and
     * all three are load-bearing rather than decoration.
     *
     * `.homePage` is the one that matters: it IS the scroller (flex:1,
     * min-height:0, overflow-y:auto), it carries the page's inset, and its
     * padding-block-end is what holds the last row clear of the player bar and
     * the nav. Wearing only `.playlistPage`, this page had none of the three -
     * it ran edge to edge, it would not scroll, and the last song sat behind
     * the now-playing bar. `.homePage.playlistPage` is a compound rule too, so
     * the tighter gap between hero and rows never applied either.
     */
    <div className="homePage libraryPage playlistPage">
      <header className="playlistHead">
        <CoverWall artworks={tracks.map((t) => t.artwork)} />
        <div className="playlistHead__cover">
          {covers.length >= 4 ? (
            <div
              ref={coversRef}
              className="tileSquircle tileLikedGrid playlistHead__mosaic"
              data-tile-pop=""
              data-tile-loading={!coversLoaded || undefined}
            >
              {covers.map((art, i) => (
                <img key={i} src={art} alt="" />
              ))}
            </div>
          ) : (
            <div className="tileSquircle tileRecent playlistHead__mosaic">
              {covers[0] ? (
                <img {...singleCover} src={covers[0]} alt="" />
              ) : (
                <ListMusic size={28} />
              )}
            </div>
          )}
        </div>

        <div className="playlistHead__body">
          {/* "Mix", not "Playlist": the kicker is the one word that says this
              list is not yours and explains why the verb below is Add. */}
          <Text tone="muted" size="xs" className="playlistHead__kicker">
            Mix
          </Text>
          <h2 className="playlistHead__name">{title}</h2>
          <Text tone="muted" size="sm">
            {tracks.length} {tracks.length === 1 ? 'song' : 'songs'}
            {totalSeconds > 0 ? ` · ${formatTotal(totalSeconds)}` : ''}
          </Text>

          <div className="playlistHead__actions">
            <Button variant="solid" size="sm" onClick={saveCopy} disabled={tracks.length === 0}>
              <Plus size={15} />
              Add
            </Button>
          </div>
        </div>
      </header>

      {tracks.length === 0 ? (
        <div className="playlistEmpty emptyState emptyState--tall">
          <EmptyArt name="search" />
          <Text tone="muted">{emptyLabel ?? 'This mix came up empty.'}</Text>
        </div>
      ) : (
        <div className="playlistPageScroll">
          {/* Not a SortableList: a mix has an order, but it is the curator's
              and dragging it here would promise an edit that goes nowhere. */}
          <div className="playlistRows">
            {tracks.map((track, i) => (
              /* The same menu a song wears everywhere else - queue it, file it,
                 keep it on this device. A song is the same song in a mix as it
                 is on a shelf. */
              <TrackMenu key={`${track.path}-${i}`} track={track} className="playlistRowMenu">
                <div className="playlistRow">
                  <RowMain track={track} onPlay={() => onPlay(track, tracks)} onOpenArtist={onOpenArtist} />
                  {/* A sibling of the row button, never nested inside it. */}
                  <button
                    type="button"
                    className="songArtist songArtistLink playlistRow__artist"
                    onClick={() => onOpenArtist(track.artist)}
                  >
                    {track.artist}
                  </button>
                  <span className="songMuted playlistRow__time">
                    {formatClock(track.duration, '--:--')}
                  </span>
                </div>
              </TrackMenu>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
