import { Button, Text, useToast } from '@glacier/react';
import { EdgeScrollRow } from '../ux/EdgeScrollRow.tsx';
import { ListMusic, Play, Plus, Shuffle } from '@glacier/icons';
import { useMemo, useRef } from 'react';
import { mosaicArts, useArtLoad, useTileArt } from '../ux/artLoad.ts';
import { shuffled } from '../ux/shuffle.ts';
import { formatTotal } from '../ux/format.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { CoverWall } from './CoverWall.tsx';
import { usePlaylists } from './playlists.tsx';
import { SongTable, type SongTableShape } from '../library/SongTable.tsx';

/** A mix is somebody else's running order: hide the library's scan date, which
 *  says nothing about the mix, and do not offer to re-sort what was curated. */
const MIX_SHAPE: SongTableShape = { hide: ['addedAt'], fixedOrder: true };
import { useServerSession } from '../servers/serverSession.tsx';
import { useWallClips } from '../library/wallClips.ts';
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
 * The header carries Play and Shuffle like the page it mirrors, then ADD.
 * Add exists because these lists are not yours and the curator's keep
 * regenerating underneath you - a copy stops moving and becomes a playlist
 * you can edit, fork-on-edit made a button. For a while Add was the ONLY
 * header verb, which made keeping a copy read as the point of the page; the
 * stations landing here is what surfaced that.
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
  // The follow-the-playing-song scroll used to live here, hunting
  // `.playlistRow__main[data-current]`. Those rows are gone: SongTable follows
  // its own rows, so a second follower would only fight it.
  const pageRef = useRef<HTMLDivElement>(null);
  const { session } = useServerSession();
  const clips = useWallClips(session);

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

  /*
   * The grid keys a row by the track's path, so a mix that names the same song
   * twice would collapse to one row rather than render two.
   *
   * The hand-rolled list this replaces keyed on `path-index`, which drew both.
   * Neither is obviously right - a mix listing a song twice is a curator's
   * artifact rather than an intention - but the collapse has to be a decision
   * somebody made rather than something the reader discovers. Deduped here, in
   * the open, keeping the first appearance and its position.
   */
  const rows = useMemo(() => {
    const seen = new Set<string>();
    return tracks.filter((t) => (seen.has(t.path) ? false : (seen.add(t.path), true)));
  }, [tracks]);

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
    <div className="homePage libraryPage playlistPage" ref={pageRef}>
      <header className="playlistHead">
        {/* Clips as well as sleeves, like the Music header: a mix opened from
            a Discover card should not drop from a moving wall to a still one.
            Cached per server, so this costs nothing after the first header. */}
        <CoverWall artworks={tracks.map((t) => t.artwork)} clips={clips} />
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

          <EdgeScrollRow className="playlistHead__actions">
            {/* Play and Shuffle lead, matching the playlist page this mirrors
                - a station or mix is for turning ON, and for a while the only
                header verb here was Add, which made keeping a copy read as
                the point of the page. Add stays, demoted to the outline. */}
            <Button
              variant="solid"
              size="sm"
              disabled={tracks.length === 0}
              onClick={() => tracks[0] && onPlay(tracks[0], tracks)}
            >
              <Play size={15} />
              Play
            </Button>
            <Button
              variant="soft"
              size="sm"
              disabled={tracks.length === 0}
              onClick={() => {
                const order = shuffled(tracks);
                if (order[0]) onPlay(order[0], order);
              }}
            >
              <Shuffle size={15} />
              Shuffle
            </Button>
            <Button variant="outline" size="sm" onClick={saveCopy} disabled={tracks.length === 0}>
              <Plus size={15} />
              Add
            </Button>
          </EdgeScrollRow>
        </div>
      </header>

      {tracks.length === 0 ? (
        <div className="playlistEmpty emptyState emptyState--tall">
          <EmptyArt name="search" />
          <Text tone="muted">{emptyLabel ?? 'This mix came up empty.'}</Text>
        </div>
      ) : (
        <div className="pageSongs">
          {/* The same table the library and Liked use. Not a SortableList: a
              mix has an order, but it is the curator's, and dragging it here
              would promise an edit that goes nowhere - `fixedOrder` says the
              same thing by not offering the handles or the sort headers. */}
          <SongTable
            flow
            defaultSort={null}
            tracks={rows}
            onPlay={(track) => onPlay(track, rows)}
            onOpenArtist={onOpenArtist}
            shape={MIX_SHAPE}
          />
        </div>
      )}
    </div>
  );
}
