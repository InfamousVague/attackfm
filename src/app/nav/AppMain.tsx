import type { Track } from '../core/tauri.ts';
import { useDeveloperMode } from '../settings/developerMode.ts';
import {
  useAcquire,
  useHasDownloadQueue,
  usePluginPages,
} from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { RoomBar, TopScrim } from './HeaderChrome.tsx';
import { UpdateBanner } from '../settings/UpdateBanner.tsx';
import { ResumeElsewhere } from '../servers/ResumeElsewhere.tsx';
import { AlbumPage } from '../albumArtist/AlbumPage.tsx';
import { ArtistPage } from '../albumArtist/ArtistPage.tsx';
import { PlaylistPage } from '../playlists/PlaylistPage.tsx';
import { MixPage } from '../playlists/MixPage.tsx';
import { SongPage, type SongCollection } from '../library/SongPage.tsx';
import { LibraryView } from '../library/LibraryView.tsx';
import { BoothPage } from '../booth/BoothPage.tsx';
import { FriendsPage } from '../profile/FriendsPage.tsx';
import { ProfilePage } from '../profile/ProfilePage.tsx';
import { StatsPage } from '../profile/StatsPage.tsx';
import { DownloadsPage } from '../downloads/DownloadsPage.tsx';

/** Re-exported so App and useNavStack can name the song-page views without
 *  reaching past this content host. */
export type { SongCollection };

/**
 * A page stacked on top of a tab: an artist, or one playlist opened whole.
 * Both behave the same way in the history - pushed inside whichever tab was
 * current, so Back returns there - which is why they are one type rather than
 * two fields that could contradict each other.
 */
export type Detail =
  | { kind: 'artist'; artist: string }
  | { kind: 'album'; album: string; artist: string }
  | { kind: 'playlist'; id: string }
  /**
   * A list somebody else made - a curator mix, a plugin's tile - opened as a
   * page. It carries its tracks rather than an id because it HAS no id: these
   * lists are computed, not stored, which is the whole reason they used to
   * open in a modal instead of routing anywhere. The stack is in memory only,
   * so carrying them costs nothing.
   */
  | { kind: 'mix'; title: string; tracks: Track[]; emptyLabel?: string }
  | { kind: 'songs'; view: SongCollection };

/**
 * The content area: whichever place is current renders here. A detail page -
 * an artist or a playlist, opened on top of any tab - wins; then a plugin page
 * whose nav item is active; then the Library tab; then Home, which is also the
 * fallback when a tab points at a plugin page that is no longer running. Reads
 * the plugin pages the same way PrimaryNav does, so the two always agree on
 * what "active" means.
 */
export function AppMain({
  detail,
  tab,
  libraryView,
  onPlay,
  onOpenArtist,
  onOpenAlbum,
  onOpenPlaylist,
  onOpenSongs,
  onCloseDetail,
  onOpenDownloads,
  onOpenStats,
  onOpenFriends,
  profileRoom,
  onProfileRoom,
  onOpenDj,
  swipeRef,
}: {
  /** The edge-swipe back gesture drags this element; App owns the hook. */
  swipeRef?: React.Ref<HTMLElement>;
  detail: Detail | null;
  tab: string;
  /** Which face Library wears; flipped by the header's All button. */
  libraryView: 'summary' | 'all';
  onPlay: (track: Track, context?: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  /** Opens one record, credited to the artist it was reached through. */
  onOpenAlbum: (album: string, albumArtist: string) => void;
  onOpenPlaylist: (id: string) => void;
  /** Opens a whole-collection song page (Liked, or every song). */
  onOpenSongs: (view: SongCollection) => void;
  onCloseDetail: () => void;
  /** The library page's own queue icon opens the downloads surface. */
  onOpenDownloads: () => void;
  /** The stats mini-cards' destination. */
  onOpenStats: () => void;
  onOpenFriends: () => void;
  /** Which of Profile's rooms is open, if any - a takeover within the tab. */
  profileRoom: 'stats' | null;
  onProfileRoom: (room: 'stats' | null) => void;
  /** Opens Music Date's fullscreen layer, from the Booth's top card. */
  /** Opens the DJ conversation's fullscreen layer; App hosts it too. */
  onOpenDj: () => void;
}) {
  // The Booth is behind developer mode. Gated HERE as well as in the nav, not
  // only there: the tab is remembered across launches, so anybody standing in
  // the Booth when the switch went off would still be standing in it. Falling
  // through lands on Library, which is where the lit nav item already says you
  // are - the deny-list that lights it treats an unmatched tab as Library.
  const showBooth = useDeveloperMode();
  const pages = usePluginPages();
  const activePage = detail ? null : (pages.find((pg) => pg.key === tab) ?? null);
  // Downloads only exists while an importer runs; without one, a tab left on
  // 'downloads' from a past session falls through to Home rather than a page
  // that should not be here.
  const hasDownloads = useDownloadsOptional() !== null;
  const hasQueue = useHasDownloadQueue();
  // Discover is gone as a destination, so nothing here gates on it any more.
  //
  // `useAcquire` is still CALLED, and unconditionally, which the line it
  // replaces was not: `hasDownloads || useAcquire().hasAny` short-circuits, so
  // the hook ran or did not depending on whether an importer happened to be
  // loaded - and the render where that flipped would have found a different
  // hook order than the one before it. PrimaryNav carries a comment about
  // having fixed exactly this; this copy was missed. Removing the last reader
  // is the moment to stop it being a live trap rather than a dormant one.
  useAcquire();
  /*
   * Which surface, if any, gets the header's shadow - and what re-arms it.
   *
   * The browsing tabs have always had it. A song collection and a playlist have
   * it now because each became a single scroller with its hero inside; the
   * collection had also been leaning on its own sticky strip: that strip was opaque (--glacier-bg), so it
   * was quietly doing this job, hiding the rows that passed beneath it. With it
   * gone the list cut off at a hard edge under the header.
   *
   * Keyed on the collection as well as the tab, so opening Liked from All
   * re-arms the listener against the new page's scroller instead of holding a
   * handle on the one that just unmounted.
   */
  // A PLUGIN PAGE gets one too. This list was written before plugin pages
  // existed as destinations, and the omission is why the Books shelf - which
  // wears the same cover-wall header a playlist does, and picks up all of that
  // header's CSS - had no fade and no shadow: the whole effect rides
  // --app-top-scroll, and nothing was publishing it there. The CSS was always
  // ready for it. Keyed on the page, so it re-arms against the new scroller.
  const scrimKey = detail
    ? detail.kind === 'songs'
      ? `songs:${detail.view}`
      : detail.kind === 'album'
        ? `album:${detail.artist}:${detail.album}`
        : detail.kind === 'playlist'
          ? `playlist:${detail.id}`
          : detail.kind === 'mix'
            ? /*
               * A MIX too, and for the third time the same reason: this list
               * predates the destination. A mix used to open in a MODAL - it
               * has no id because it is computed rather than stored - so when
               * it became a page it inherited MixPage's cover-wall header and
               * every rule that dresses it, and none of the wiring that fades
               * the bar above it. Nothing publishes --app-top-scroll, so the
               * bar stays flat black from the first pixel and the rows cut off
               * at a hard edge, which reads as "playlists lost the fade" -
               * a playlist still has it; the thing that looks identical to one
               * never did.
               *
               * Keyed on title and length rather than an id, being what a mix
               * has: enough to re-arm the listener when you open a different
               * one, which is all the key is for.
               */
              `mix:${detail.title}:${detail.tracks.length}`
            : detail.kind === 'artist'
              ? `artist:${detail.artist}`
              : null
    : activePage
      ? `page:${activePage.key}`
      : tab === 'home' || tab === 'library'
        ? tab
        : null;

  return (
    <main className="appContent" ref={swipeRef}>
      {/* Above the pages but INSIDE the content column. It cannot live one
          level up in .appBody: that is a flex ROW, so a banner there becomes a
          column beside the app and squeezes it to nothing the moment it shows.
          Here it stacks over whichever page is on, and still outlives the page
          it sits above - an update is news about the whole app, and a page
          that unmounts on navigation would take the notice with it. */}
      <UpdateBanner />
      {/* The other half of "keep my place across devices": the app has been
          writing that place to the account for a long time and never once read
          it back. An offer, not an action - see ResumeElsewhere. */}
      <ResumeElsewhere onPlay={onPlay} />
      {/* The top of the page mirrors the bottom: scrolled content dissolves
          into black under the header instead of cutting off at its edge. Only
          once scrolled - parked at the top there is nothing to dissolve and
          the scrim is invisible. See scrimKey above for which pages get it. */}
      {scrimKey && <TopScrim resetKey={scrimKey} />}
      {detail?.kind === 'artist' ? (
        <ArtistPage
          artist={detail.artist}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onOpenAlbum={onOpenAlbum}
          onOpenPlaylist={onOpenPlaylist}
        />
      ) : detail?.kind === 'album' ? (
        <AlbumPage
          album={detail.album}
          artist={detail.artist}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onGone={onCloseDetail}
        />
      ) : detail?.kind === 'playlist' ? (
        <PlaylistPage
          id={detail.id}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onGone={onCloseDetail}
        />
      ) : detail?.kind === 'mix' ? (
        <MixPage
          title={detail.title}
          tracks={detail.tracks}
          emptyLabel={detail.emptyLabel}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onOpenPlaylist={onOpenPlaylist}
        />
      ) : detail?.kind === 'songs' ? (
        // Liked or every song, opened full - the library's own views as a page.
        <SongPage view={detail.view} onPlay={onPlay} onOpenArtist={onOpenArtist} />
      ) : activePage ? (
        activePage.render({ onPlay, onOpenArtist, onOpenPlaylist, onOpenSongs })
      ) : tab === 'library' ? (
        // Library: what you HAVE - the shelves and the full song table.
        <LibraryView
          view={libraryView}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onOpenAlbum={onOpenAlbum}
          onOpenPlaylist={onOpenPlaylist}
          onOpenSongs={onOpenSongs}
          onOpenDownloads={hasQueue ? onOpenDownloads : undefined}
          onOpenStats={onOpenStats}
        />
      ) : tab === 'booth' && showBooth ? (
        // The Booth: the taste engine's one body - the DJ conversation, the
        // mixes it built, what it is doing right now, and its own preferences.
        <BoothPage
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onOpenDj={onOpenDj}
        />
      ) : tab === 'friends' ? (
        // The people, their own page now - the grid of artist-backed cards
        // wants the whole screen. 'friends' was already the tab's old alias
        // for Profile, and pointing it here is the honest reading of the name.
        <FriendsPage onPlay={onPlay} onOpenArtist={onOpenArtist} />
      ) : tab === 'profile' ? (
        // Profile: the "about you" home. Its room - This week (the stats) -
        // is a takeover WITHIN the tab, a back bar returning to the profile.
        // Music Date used to be a second room here; it lives at the top of
        // the Booth now, as a fullscreen layer.
        profileRoom === 'stats' ? (
          <div className="profileRoomHost">
            <RoomBar label="This week" onBack={() => onProfileRoom(null)} />
            <StatsPage onPlay={onPlay} onOpenArtist={onOpenArtist} />
          </div>
        ) : (
          <ProfilePage onOpenFriends={onOpenFriends} onOpenRoom={onProfileRoom} />
        )
      ) : tab === 'downloads' && hasQueue ? (
        <DownloadsPage />
      ) : (
        // The default is the Library now, and it carries the personalized mixes
        // (folded in from the old Home) above the shelves of what you own.
        <LibraryView
          view={libraryView}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onOpenAlbum={onOpenAlbum}
          onOpenPlaylist={onOpenPlaylist}
          onOpenSongs={onOpenSongs}
          onOpenDownloads={hasQueue ? onOpenDownloads : undefined}
          onOpenStats={onOpenStats}
        />
      )}
    </main>
  );
}
