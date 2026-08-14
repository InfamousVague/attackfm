import {
  Button,
  HapticsProvider,
  IconButton,
  LocaleProvider,
  NavBar,
  NavBarItem,
  TitleBar,
  ToastProvider,
} from '@glacier/react';
import { ChartNoAxesColumn, ChevronLeft, ChevronRight, CircleUserRound, Compass, Download, LibraryBig, Search, Settings } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppearanceProvider } from './appearance.tsx';
import { LibraryProvider, useLibrary } from './library.tsx';
import { ServerSessionProvider, useServerSession } from './serverSession.tsx';
import { RegistrySessionProvider } from './registrySession.tsx';
import { EqualizerProvider } from './equalizer.tsx';
import { PlaybackProvider } from './playback.tsx';
import { PlaybackSyncProvider, useConnect } from './playbackSync.tsx';
import { NowPlayingMotionProvider } from './nowPlayingMotion.tsx';
import { NowPlayingBackdrop } from './NowPlayingBackdrop.tsx';
import {
  AcquireProvider,
  PluginHookScope,
  PluginProviders,
  PluginSlot,
  PluginsProvider,
  useAcquire,
  useHasDownloadQueue,
  usePluginPages,
} from '../plugins/runtime.tsx';
import { isDesktopApp } from './platform.ts';
import { onCarPlayPlay } from './carplay.ts';
import { remotePath, trackIdFromPath } from './server.ts';
import type { Track } from './tauri.ts';
import { Player } from './Player.tsx';
import { QueueControlsBridge } from './queueControls.tsx';
import { ArtistPage } from './ArtistPage.tsx';
import { PlaylistPage } from './PlaylistPage.tsx';
import { DownloadsPage } from './DownloadsPage.tsx';
import { RadioProvider } from './radio.tsx';
import { SettingsModal } from './SettingsModal.tsx';
import { PlaylistsProvider } from './playlists.tsx';
import { LibrarySyncProvider } from './librarySync.tsx';
import { SearchPage } from './SearchPage.tsx';
import { StatsPage } from './StatsPage.tsx';
import { AiPage } from './AiPage.tsx';
import { ServersPage } from './ServersPage.tsx';
import { FriendsPage } from './FriendsPage.tsx';
import { UpdateBanner } from './UpdateBanner.tsx';
import { DjPage } from './DjPage.tsx';
import { DjChatProvider } from './djChat.tsx';
import { DatePage } from './DatePage.tsx';
import { ListeningShareBridge } from './listeningShare.tsx';
import { LibraryView } from './LibraryView.tsx';
import { SongPage, type SongCollection } from './SongPage.tsx';
import {
  PendingPlayProvider,
  PendingPlayWatcher,
  isPendingPath,
} from './pendingPlay.tsx';
import { useSwipeBack } from './useSwipeBack.ts';
import { onSystemBack, useSystemBack } from './systemBack.ts';
import { hapticsImpl, installTapHaptics, useHapticsPref } from './haptics.ts';
import { installOverlayGuard } from './overlayGuard.ts';
import { DiscoverPage } from '../plugins/discover/DiscoverPage.tsx';
import { ProfilePage } from './ProfilePage.tsx';
import { JamProvider } from './jam.tsx';
import { MobileAuthGate } from './MobileAuthGate.tsx';
import { NavMoreMenu } from './NavMoreMenu.tsx';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';
import wordmark from '../assets/attack-white.png';

const APP_NAME = 'AttackFM';

// Window chrome only makes sense where there is a window to decorate: a desktop
// Tauri build. A phone build is inside Tauri too, but has no frame and no
// traffic lights - so it gets the plain header below instead, as does the
// browser.
const DESKTOP = isDesktopApp;

/**
 * Turns a tap on the car screen into playback here, where the audio lives.
 *
 * The car names the track and the list it was tapped in; the queue is rebuilt
 * from that context in the same order the car displayed - liked order for
 * Liked, album-then-track-number within an artist, alphabetical for Songs -
 * so the drive hears what the screen promised. Headless, and a separate
 * component below the LibraryProvider because App itself renders that provider
 * and so cannot read the library.
 */
function CarPlayBridge({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { tracks, favoriteTracks } = useLibrary();
  const latest = useRef({ tracks, favoriteTracks, onPlay });
  latest.current = { tracks, favoriteTracks, onPlay };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let dead = false;
    void onCarPlayPlay((trackId, context) => {
      const { tracks, favoriteTracks, onPlay } = latest.current;
      const path = remotePath(trackId);
      const track = tracks.find((t) => t.path === path);
      if (!track) return;

      let queue: Track[];
      if (context === 'liked') {
        queue = favoriteTracks;
      } else if (context.startsWith('artist:')) {
        const artist = context.slice('artist:'.length);
        queue = tracks
          .filter((t) => t.artist === artist)
          .sort(
            (a, b) =>
              a.album.localeCompare(b.album, undefined, { sensitivity: 'base' }) ||
              (a.trackNo ?? 0) - (b.trackNo ?? 0),
          );
      } else {
        queue = [...tracks].sort((a, b) =>
          a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }),
        );
      }
      onPlay(track, queue.length > 0 ? queue : [track]);
    }).then((stop) => {
      if (dead) stop();
      else unlisten = stop;
    });
    return () => {
      dead = true;
      unlisten?.();
    };
  }, []);
  return null;
}

/**
 * A slim strip along the bottom that reports background library work, shown
 * only while it runs. It sits above the floating player and disappears the
 * moment the library is settled.
 *
 * Two wordings for the two sources, one pill. A local scan knows its total up
 * front (the folder walk came first), so it earns a real percent; a server
 * sync is a delta whose size is only known when it is over, so it wears the
 * count it has and an indeterminate sweep instead of a percentage that would
 * be a guess.
 */
function IndexingStatus() {
  const { source, indexing, indexed, indexTotal } = useLibrary();
  if (!indexing) return null;

  if (source === 'server') {
    return (
      <div className="indexingBar" role="status" aria-live="polite">
        <span className="indexingBar__dot" aria-hidden="true" />
        <span className="indexingBar__label">
          {indexed > 0 ? `Syncing · ${indexed.toLocaleString()} songs` : 'Syncing library…'}
        </span>
        <span className="indexingBar__track" aria-hidden="true">
          <span className="indexingBar__fill indexingBar__fill--sweep" />
        </span>
      </div>
    );
  }

  if (indexTotal === 0) return null;
  const percent = Math.min(100, Math.round((indexed / indexTotal) * 100));
  return (
    <div className="indexingBar" role="status" aria-live="polite">
      <span className="indexingBar__dot" aria-hidden="true" />
      <span className="indexingBar__label">
        Indexing {indexed.toLocaleString()} of {indexTotal.toLocaleString()} songs
      </span>
      <span className="indexingBar__track" aria-hidden="true">
        <span className="indexingBar__fill" style={{ inlineSize: `${percent}%` }} />
      </span>
    </div>
  );
}


/**
 * The primary navigation, in the shape each platform holds: a vertical icon
 * rail on the desktop, a floating horizontal bar on the phone. Both carry the
 * same items - the core Home and Library tabs, then one per plugin page in
 * registration order - so a plugin's page is a first-class destination
 * wherever the app runs.
 *
 * It reads the plugin pages itself (usePluginPages) rather than taking them as
 * a prop, so it must render inside the provider tree - which it does, seated
 * below PluginsProvider like PluginSlot. The current tab and the callbacks are
 * plain props from App, whose state lives above the plugin providers and so
 * survives a plugin toggle untouched.
 */
function PrimaryNav({
  variant,
  tab,
  onTab,
  onSettings,
}: {
  variant: 'rail' | 'bar';
  /** The active tab: 'home', 'library', or a plugin page's `${id}:${page}` key. */
  tab: string;
  onTab: (tab: string) => void;
  onSettings: () => void;
}) {
  const pages = usePluginPages();
  // Downloads is a plugin surface, not a core one: the tab appears only while an
  // importer is actually running (it provides the downloads bridge). With no
  // importer - a fresh install, or anyone who has not added a plugin source -
  // there is nothing to download, so the tab is absent rather than a dead end.
  const dl = useDownloadsOptional();
  const hasDownloads = dl !== null;
  // Any queue at all, the importer's or a plugin's - what the Downloads tab
  // itself is gated on, where `hasDownloads` stays "the music importer runs".
  const hasQueue = useHasDownloadQueue();
  // How many imports are in flight, for the rail item's badge - the one thing
  // the old popover trigger said that a plain nav item would not.
  const dlActive = dl?.active.length ?? 0;
  // Discover appears whenever there is ANY way to acquire music - an importer
  // to download through, or a Buy handler to purchase through. Only a build with
  // no acquire handlers at all (the plugin-free App-Review server) hides it.
  const canDiscover = hasDownloads || useAcquire().hasAny;
  // A tab pointing at a plugin page whose plugin was just switched off reads as
  // Home - the same fallback the content host makes - so the lit item never
  // disagrees with what is actually on screen.
  const onPluginPage = pages.some((pg) => pg.key === tab);
  // The library is the app's home now: the default tab and the catch for any
  // tab that is not an explicit destination, so its nav item lights whenever
  // the library (mixes and all) is what is on screen.
  const libraryActive =
    tab === 'library' ||
    tab === 'home' ||
    (tab !== 'discover' &&
      tab !== 'downloads' &&
      tab !== 'friends' &&
      tab !== 'profile' &&
      tab !== 'search' &&
      tab !== 'stats' &&
      // Built-in pages that own their own route. Without these the deny-list
      // lights Library while you are standing on the DJ or the AI page - the
      // trap of listing what is NOT library instead of what is.
      tab !== 'ai' &&
      tab !== 'dj' &&
      tab !== 'date' &&
      tab !== 'servers' &&
      !onPluginPage);

  const primaryItems = (
    <>
      {/* Library leads: the music you actually own, plus the mixes made from it.
          Discover sits beside it as the place you go to find what you do NOT
          have - and appears whenever there is a way to acquire (import or buy). */}
      <NavBarItem
        icon={<LibraryBig size={18} />}
        label="Library"
        active={libraryActive}
        onClick={() => onTab('library')}
      />
      {canDiscover && (
        <NavBarItem
          icon={<Compass size={18} />}
          label="Discover"
          active={tab === 'discover'}
          onClick={() => onTab('discover')}
        />
      )}
      {/* Downloads is NOT a nav destination. On the phone it is an icon on the
          library page (where the music it is fetching ends up); on the desktop
          the rail anchors the queue button to its foot, by Settings - see the
          `end` slot below. A queue you visit occasionally does not deserve a
          permanent seat in a bar of four. */}
      {/* Search is a destination like Library and Discover: results you can
          scroll, narrow and come back to, which a sheet over the page fought
          on all three counts. */}
      <NavBarItem
        icon={<Search size={18} />}
        label="Search"
        active={tab === 'search'}
        onClick={() => onTab('search')}
      />
      {/* Plugin pages ride the rail as their own items on the desktop, which
          has the vertical room; the phone bar folds them into its Plugins
          button (cascading up out of the bar) instead. */}
      <NavBarItem
        icon={<CircleUserRound size={18} />}
        label="Profile"
        active={tab === 'profile' || tab === 'friends'}
        onClick={() => onTab('profile')}
      />
      {pages.map((pg) => (
        <NavBarItem
          key={pg.key}
          icon={pg.icon}
          label={pg.label}
          active={tab === pg.key}
          onClick={() => onTab(pg.key)}
        />
      ))}
    </>
  );

  if (variant === 'rail') {
    return (
      <NavBar
        orientation="vertical"
        aria-label="Primary"
        className="appNavRail"
        end={
          <div className="appNavRail__foot">
            {/* The download queue is a PAGE, so its door in the rail is a nav
                item like any other - not a popover that closes the moment you
                look away from a ten-minute job. The badge carries the count
                the old popover trigger wore. Absent when no importer runs, so
                the foot is only ever Settings in that case. */}
            {hasQueue && (
              <NavBarItem
                icon={
                  <span className="appNavRail__dlIcon">
                    <Download size={18} />
                    {dlActive > 0 && <span className="appNavRail__dlBadge">{dlActive}</span>}
                  </span>
                }
                label="Downloads"
                active={tab === 'downloads'}
                onClick={() => onTab('downloads')}
              />
            )}
            <NavBarItem icon={<Settings size={18} />} label="Settings" onClick={onSettings} />
          </div>
        }
      >
        {primaryItems}
      </NavBar>
    );
  }

  // The phone bar: a floating island of even tabs. It had a raised brand disc
  // in the middle for the library, which made the library look like a different
  // KIND of thing from Search and Friends when it is simply another
  // destination - and cost the plate a band of height to overhang into. It is
  // an ordinary tab now, in its place in the row, lit like any other.
  //
  // Plugin pages do NOT take their own bar seats: they gather behind the one
  // Plugins button in the right group (PluginsBarButton), which cascades them
  // up out of the bar - so the core tabs stay put however many plugins are on.
  return (
    <nav className="appNavBar" aria-label="Primary">
      {/* A destination, so it lights like one. */}
      <BarTab
        icon={<Search size={24} />}
        label="Search"
        active={tab === 'search'}
        onClick={() => onTab('search')}
      />
      {canDiscover && (
        <BarTab
          icon={<Compass size={24} />}
          label="Discover"
          active={tab === 'discover'}
          onClick={() => onTab('discover')}
        />
      )}
      {/* The library: where the music you own lives, and the app's home. */}
      <BarTab
        icon={<LibraryBig size={24} />}
        label="Library"
        active={libraryActive}
        onClick={() => onTab('library')}
      />
      <BarTab
        icon={<CircleUserRound size={24} />}
        label="Profile"
        active={tab === 'profile' || tab === 'friends'}
        onClick={() => onTab('profile')}
      />
      {/* The overflow: the ⋮ menu cascades up the plugin pages plus Stats,
          Downloads and Settings. */}
      <NavMoreMenu tab={tab} onTab={onTab} onSettings={onSettings} />
      {/* Settings left the bar for the header's top-right (mobileHeader), so
          this side holds two tabs like the other - three was a crowd. */}
    </nav>
  );
}

/**
 * The header's shadow, cast only while there is something under it: a black
 * gradient over the top of the content area whose opacity IS the scroll -
 * zero parked at the top, full a few dozen pixels in, every value between
 * ridden frame-by-frame. Self-contained: it listens on its parent (the
 * content host) in the capture phase, so whichever page element is doing the
 * scrolling - each page is its own scroller - one listener hears it without
 * anyone threading refs. Direct style writes, no React state: scroll is the
 * hottest event there is, and the scrim is the only reader.
 */
function TopScrim({ resetKey }: { resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = ref.current;
    const host = node?.parentElement;
    if (!node || !host) return;
    // A fresh page mounts parked at the top; start invisible.
    node.style.opacity = '0';
    const onScroll = (event: Event) => {
      const target = event.target;
      // Only the page scroller (a direct child of the host) drives the scrim -
      // inner scrollers (track lists, shelves) pass under it untouched.
      if (!(target instanceof HTMLElement) || target.parentElement !== host) return;
      node.style.opacity = String(Math.min(1, Math.max(0, target.scrollTop) / 56));
    };
    host.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => host.removeEventListener('scroll', onScroll, { capture: true });
  }, [resetKey]);
  return <div ref={ref} className="appTopScrim" aria-hidden="true" />;
}

/** One tab in the floating phone bar: a glyph over a small label, lit when
 *  it is the page you are on. */
function BarTab({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="appNavBarTab"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="appNavBarTab__icon">{icon}</span>
      <span className="appNavBarTab__label">{label}</span>
    </button>
  );
}

/**
 * Whether the strip exists, and what it holds.
 *
 * A device that has played nothing of its own still needs the transport when
 * the music is playing SOMEWHERE: Connect makes every signed-in device a remote
 * for whichever one holds the audio, and a remote with no strip can neither
 * watch the progress nor take the controls - which is most of the point of
 * having Connect at all. So the bar appears for a local track OR for the track
 * another device is playing, and the Player's own remote mode does the rest
 * (it shows that device's clock and sends commands instead of playing).
 *
 * Lives inside the Connect provider because only a child of it can read the
 * shared session.
 */
function PlayerHost({
  current,
  queue,
  onTrackChange,
  onQueueChange,
  onOpenArtist,
  autoplay,
  hidden = false,
}: {
  current: Track | null;
  queue: Track[];
  onTrackChange: (track: Track) => void;
  onQueueChange: (queue: Track[]) => void;
  /** The Now Playing sheet's artist line opens the artist page through here. */
  onOpenArtist: (artist: string) => void;
  autoplay: boolean;
  /** Date mode's floor: the strip hides (and the page below reclaims its
   *  space) while the deck itself stays mounted - tearing the Player down
   *  would take the audio graph, the scrub state and the session's seed with
   *  it, when all Date needs is silence and a clean screen. DatePage pauses
   *  the audio on entry; this keeps the paused strip from hanging under the
   *  cards pretending something is playing. */
  hidden?: boolean;
}) {
  const connect = useConnect();
  const { tracks } = useLibrary();
  const elsewhere =
    connect.session?.activeDeviceId != null &&
    connect.session.activeDeviceId !== connect.thisDeviceId;
  const remoteId = elsewhere ? connect.session?.trackId : null;
  const remoteTrack =
    remoteId != null
      ? (tracks.find((t) => trackIdFromPath(t.path) === remoteId) ?? null)
      : null;
  // A local track always wins: this device's own deck is what its transport
  // drives once it has one.
  const shown = current ?? remoteTrack;
  if (!shown) return null;
  return (
    <div className="appPlayer" data-hidden={hidden || undefined}>
      {/* The player walks the queue itself; it only reports where it
          landed, and `current` follows. */}
      <Player
        track={shown}
        queue={queue}
        onTrackChange={onTrackChange}
        onQueueChange={onQueueChange}
        onOpenArtist={onOpenArtist}
        // Nothing this device chose to play, so nothing to start.
        autoplay={current ? autoplay : false}
        // The docked sheet may only stand for THIS device's deck. While the
        // strip mirrors a remote (current is null, shown is the remote's
        // track), the sheet's own clock and transport are honestly empty -
        // it was never reachable in that state before the dock existed, and
        // mounting it there showed a dead player beside a live strip.
        allowDock={current !== null}
      />
    </div>
  );
}

/**
 * A page stacked on top of a tab: an artist, or one playlist opened whole.
 * Both behave the same way in the history - pushed inside whichever tab was
 * current, so Back returns there - which is why they are one type rather than
 * two fields that could contradict each other.
 */
type Detail =
  | { kind: 'artist'; artist: string }
  | { kind: 'playlist'; id: string }
  | { kind: 'songs'; view: SongCollection };

/**
 * The content area: whichever place is current renders here. A detail page -
 * an artist or a playlist, opened on top of any tab - wins; then a plugin page
 * whose nav item is active; then the Library tab; then Home, which is also the
 * fallback when a tab points at a plugin page that is no longer running. Reads
 * the plugin pages the same way PrimaryNav does, so the two always agree on
 * what "active" means.
 */
function AppMain({
  detail,
  tab,
  libraryView,
  onPlay,
  onOpenArtist,
  onOpenPlaylist,
  onOpenSongs,
  onCloseDetail,
  onOpenDownloads,
  onOpenStats,
  onOpenFriends,
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
  onOpenPlaylist: (id: string) => void;
  /** Opens a whole-collection song page (Liked, or every song). */
  onOpenSongs: (view: SongCollection) => void;
  onCloseDetail: () => void;
  /** The library page's own queue icon opens the downloads surface. */
  onOpenDownloads: () => void;
  /** The stats mini-cards' destination. */
  onOpenStats: () => void;
  onOpenFriends: () => void;
}) {
  const pages = usePluginPages();
  const activePage = detail ? null : (pages.find((pg) => pg.key === tab) ?? null);
  // Downloads only exists while an importer runs; without one, a tab left on
  // 'downloads' from a past session falls through to Home rather than a page
  // that should not be here.
  const hasDownloads = useDownloadsOptional() !== null;
  // The server owner - the first account through the door. The AI page is
  // theirs alone; everyone else never sees the row or the route.
  const isOwner = useServerSession().session?.isAdmin === true;
  const hasQueue = useHasDownloadQueue();
  // Discover is reachable whenever there is any acquire handler (import or buy),
  // matching the nav gate; the plugin-free App-Review build has neither.
  const canDiscover = hasDownloads || useAcquire().hasAny;
  return (
    <main className="appContent" ref={swipeRef}>
      {/* Above the pages but INSIDE the content column. It cannot live one
          level up in .appBody: that is a flex ROW, so a banner there becomes a
          column beside the app and squeezes it to nothing the moment it shows.
          Here it stacks over whichever page is on, and still outlives the page
          it sits above - an update is news about the whole app, and a page
          that unmounts on navigation would take the notice with it. */}
      <UpdateBanner />
      {/* The top of the page mirrors the bottom: scrolled content dissolves
          into black under the header instead of cutting off at its edge.
          Only on the three browsing surfaces, and only once scrolled - parked
          at the top there is nothing to dissolve and the scrim is invisible. */}
      {!detail && (tab === 'home' || tab === 'library' || tab === 'discover' || tab === 'search') && (
        <TopScrim resetKey={tab} />
      )}
      {detail?.kind === 'artist' ? (
        <ArtistPage
          artist={detail.artist}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onOpenPlaylist={onOpenPlaylist}
        />
      ) : detail?.kind === 'playlist' ? (
        <PlaylistPage
          id={detail.id}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onGone={onCloseDetail}
        />
      ) : detail?.kind === 'songs' ? (
        // Liked or every song, opened full - the library's own views as a page.
        <SongPage view={detail.view} onPlay={onPlay} onOpenArtist={onOpenArtist} />
      ) : activePage ? (
        activePage.render({ onPlay, onOpenArtist })
      ) : tab === 'library' ? (
        // Library: what you HAVE - the shelves and the full song table.
        <LibraryView
          view={libraryView}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onOpenPlaylist={onOpenPlaylist}
          onOpenSongs={onOpenSongs}
          onOpenDownloads={hasQueue ? onOpenDownloads : undefined}
          onOpenStats={onOpenStats}
        />
      ) : tab === 'discover' && canDiscover ? (
        // Discover: what you do NOT have - the server's curated charts and a
        // live search across Spotify + Deezer, each a one-tap add. Gated on any
        // acquire handler (import or buy), so a build with no way to add through
        // (the plugin-free App-Review server) never surfaces it.
        <DiscoverPage onPlay={onPlay} onOpenArtist={onOpenArtist} />
      ) : tab === 'search' ? (
        // Search: everything you own, everyone you know, and what you could
        // add - one query across all of them. Inside a plugin hook scope
        // because it asks plugins for commands (a pasted link is an action,
        // not a query); the scope's remount on a changed plugin set is what
        // keeps that hook order legal.
        <PluginHookScope>
          <SearchPage
            onPlay={onPlay}
            onOpenArtist={onOpenArtist}
            onOpenPlaylist={onOpenPlaylist}
          />
        </PluginHookScope>
      ) : tab === 'date' ? (
        // The collector's auditions as introductions: snippet, swipe, verdict.
        <DatePage />
      ) : tab === 'dj' ? (
        // The DJ, as a conversation. Not owner-gated: it reads the CALLER's own
        // taste and the caller's own pulls, so it is correct for everyone on the
        // hub - unlike the AI page below, which reports on the server itself.
        <DjPage />
      ) : tab === 'ai' && isOwner ? (
        // What the machine did while you were not looking. Owner-only, and
        // gated here as well as in the menu: a tab restored from a past session
        // (or an account that stopped being the owner) falls through to the
        // library rather than opening a page it should not see.
        <AiPage />
      ) : tab === 'servers' ? (
        // Where the bytes come from: every linked server, how near it is, how
        // much of the library it holds, and - where this account hosts the box
        // - what to delete to make room.
        <ServersPage />
      ) : tab === 'stats' ? (
        // Stats: the listening, added up - fed by the same event log the
        // curator tunes itself on.
        <StatsPage onPlay={onPlay} onOpenArtist={onOpenArtist} />
      ) : tab === 'friends' ? (
        // The people, their own page now - the grid of artist-backed cards
        // wants the whole screen. 'friends' was already the tab's old alias
        // for Profile, and pointing it here is the honest reading of the name.
        <FriendsPage />
      ) : tab === 'profile' ? (
        // Profile: who you are - identity, live jams, your servers, your
        // friends. 'friends' is the tab's old name, honoured so a stored
        // session lands here rather than falling through to the library.
        <ProfilePage onOpenFriends={onOpenFriends} />
      ) : tab === 'downloads' && hasQueue ? (
        <DownloadsPage />
      ) : (
        // The default is the Library now, and it carries the personalized mixes
        // (folded in from the old Home) above the shelves of what you own.
        <LibraryView
          view={libraryView}
          onPlay={onPlay}
          onOpenArtist={onOpenArtist}
          onOpenPlaylist={onOpenPlaylist}
          onOpenSongs={onOpenSongs}
          onOpenDownloads={hasQueue ? onOpenDownloads : undefined}
          onOpenStats={onOpenStats}
        />
      )}
    </main>
  );
}

/**
 * Bridges playFrom to AttackFM Connect. Renders nothing; it just keeps a router
 * function in the ref App holds, refreshed whenever the shared session changes.
 * When another device holds audio, the router forwards a pick to it as a
 * setQueue command (the whole list, so that device's skips follow it) and
 * returns true; App then skips local playback, so a song picked on any device -
 * even one not playing the audio - changes the song for every device.
 */
function ConnectPlayRouter({
  routeRef,
}: {
  routeRef: { current: ((track: Track, context?: Track[]) => boolean) | null };
}) {
  const connect = useConnect();
  useEffect(() => {
    routeRef.current = (track, context) => {
      const activeElsewhere =
        connect.connected &&
        connect.session?.activeDeviceId != null &&
        connect.session.activeDeviceId !== connect.thisDeviceId;
      if (!activeElsewhere) return false;
      const list = context ?? [track];
      const ids = list
        .map((t) => trackIdFromPath(t.path))
        .filter((x): x is number => x !== null);
      if (ids.length === 0) return false;
      const pickId = trackIdFromPath(track.path);
      const index = Math.max(
        0,
        pickId == null ? 0 : ids.indexOf(pickId),
      );
      connect.sendCommand({ action: 'setQueue', queue: ids, index });
      return true;
    };
    return () => {
      routeRef.current = null;
    };
  }, [connect, routeRef]);
  return null;
}

/**
 * The app root: a small square window carrying the cross-cutting Glacier
 * providers and, for now, a single centered placeholder screen.
 */
export function App() {
  // Which face the Library shows: its shelves, or every song as one table.
  // Lives here rather than in the page because the header's "All" button is
  // the only thing that flips it - the segmented toggle it replaced lived in
  // the page body and spent a full row on two options.
  // The library shows its shelves; the one-table "All" view lost its header
  // toggle, so the value stays 'summary'. Kept as state so AppMain's prop and
  // its type need no change if the flip returns elsewhere later.
  const [libraryView] = useState<'summary' | 'all'>('summary');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // A system back swipe closes Settings before it touches the page history.
  useSystemBack(settingsOpen, () => setSettingsOpen(false));
  // The app-wide tap tick, bound to the Settings switch. Mounted only while the
  // preference is on, so turning haptics off really does remove the listener
  // rather than leaving one that checks a flag on every touch - and turning it
  // back on takes effect immediately, with no reload.
  const hapticsOn = useHapticsPref();
  useEffect(() => {
    if (!hapticsOn) return;
    return installTapHaptics();
  }, [hapticsOn]);
  // A dropdown opened inside a popover portals out of it, which the popover
  // reads as a press outside itself. See overlayGuard.
  useEffect(() => installOverlayGuard(), []);
  // The track the list handed to the player; null until one is opened.
  const [current, setCurrent] = useState<Track | null>(null);
  // The list that track was opened from, in the order it was showing - what
  // the player's skips and autoplay walk through. Snapshotted at open, the
  // way a play context should be: re-sorting the table later reorders the
  // table, not the record already spinning.
  const [queue, setQueue] = useState<Track[]>([]);
  // Stable for the station's refill effect, which lists it as a dependency:
  // a fresh closure each render would re-ask the hub on every paint.
  const extendQueue = useCallback(
    (more: Track[]) => setQueue((prev) => [...prev, ...more]),
    [],
  );

  // Every surface that starts playback comes through here: the track to play
  // and the list it came from. A surface with no list (a lone hit) plays the
  // one track and the strip drops its skip buttons. Re-selecting the track
  // already loaded hands the player a fresh object: its load effect is keyed
  // on identity, and the same object again would make the click do nothing -
  // where the convention is a restart from the top. Everything downstream
  // compares tracks by path, so the clone changes nothing else.
  // False until the user picks something themselves: the launch seed loads
  // the deck without dropping the needle.
  const [autoplay, setAutoplay] = useState(false);
  // The import job the current placeholder waits on while a tapped remote song
  // downloads (see pendingPlay.tsx). Null when nothing is downloading.
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  // Populated by ConnectPlayRouter (which lives inside the Connect provider and
  // so can read the shared session). When another device holds audio, it routes
  // a pick to that device and returns true; playFrom then does nothing locally,
  // so the song changes on every device while control stays where it is.
  const connectRouteRef = useRef<((track: Track, context?: Track[]) => boolean) | null>(null);

  const playFrom = (track: Track, context?: Track[]) => {
    // Another device is the one playing: hand it the pick rather than seizing
    // playback here. The active device loads and plays it, then reports, and
    // this device (a remote) updates from that report like any other.
    if (connectRouteRef.current?.(track, context)) return;
    setAutoplay(true);
    setCurrent((prev) => (prev === track ? { ...track } : track));
    setQueue(context ?? [track]);
  };

  // A song tapped in Discover/Search that this device does not own yet: show it
  // in Now Playing under a "Downloading" state - the placeholder carries its
  // art, title and artist - while its import runs, then let the watcher swap in
  // the real file and start playback. Not routed anywhere; routing happens when
  // the real track finally plays.
  const playPending = (placeholder: Track, jobId: string) => {
    setAutoplay(false);
    setCurrent(placeholder);
    setQueue([placeholder]);
    setPendingJobId(jobId);
  };
  const onPendingResolved = (real: Track) => {
    setPendingJobId(null);
    // Play it as any pick would (routing to the active device if one holds
    // audio). If routing sent it elsewhere, playFrom left `current` on the
    // placeholder, so swap that out here too.
    playFrom(real, [real]);
    setCurrent((c) => (c && isPendingPath(c.path) ? real : c));
  };
  const onPendingFailed = () => {
    // The import failed (the watcher toasts): drop the placeholder if it is
    // still current. Nothing was playing under it, so the strip simply clears.
    setPendingJobId(null);
    setCurrent((c) => (c && isPendingPath(c.path) ? null : c));
  };
  // The placeholder the watcher matches a finished local import back against.
  const pendingPlaceholder = current && isPendingPath(current.path) ? current : null;

  // Queue editing (see queueControls.tsx). The queue is just `queue` in play
  // order; the current track's spot is found by path, so inserting after it,
  // appending, reordering or removing is all a matter of rewriting the array -
  // the player's skips read whatever it holds now. Kept path-deduped so those
  // by-path lookups stay unambiguous. Read `current` through a ref so the two
  // verbs stay stable (they ride in a context) yet always see the live track.
  const currentRef = useRef(current);
  currentRef.current = current;
  const playFromRef = useRef(playFrom);
  playFromRef.current = playFrom;
  const addToQueue = useCallback((track: Track) => {
    const cur = currentRef.current;
    if (!cur) return playFromRef.current(track, [track]);
    if (track.path === cur.path) return;
    setQueue((q) => (q.some((t) => t.path === track.path) ? q : [...q, track]));
  }, []);
  const playNext = useCallback((track: Track) => {
    const cur = currentRef.current;
    if (!cur) return playFromRef.current(track, [track]);
    if (track.path === cur.path) return;
    setQueue((q) => {
      const without = q.filter((t) => t.path !== track.path);
      const at = without.findIndex((t) => t.path === cur.path) + 1;
      // findIndex -1 (current not in the list) + 1 = 0 would jump it to the
      // very front; fall to the end instead, which is the honest "next" when
      // there is no known position to insert after.
      const insert = at === 0 ? without.length : at;
      return [...without.slice(0, insert), track, ...without.slice(insert)];
    });
  }, []);
  // Page history as a stack with a cursor, so back and forward move through
  // the places visited rather than just toggling. A place is a primary tab
  // plus, within it, an optional detail page - the tab is what the nav bar
  // lights, whether or not a detail is open on top of it. The tab is 'home',
  // 'library', or a plugin page's namespaced `${pluginId}:${pageId}` key; the
  // nav and the content host resolve the last kind against the running plugins.
  type Place = { tab: string; detail: Detail | null };
  const sameDetail = (a: Detail | null | undefined, b: Detail | null) =>
    a?.kind !== b?.kind
      ? false
      : a?.kind === 'artist' && b?.kind === 'artist'
        ? a.artist === b.artist
        : a?.kind === 'playlist' && b?.kind === 'playlist'
          ? a.id === b.id
          : a?.kind === 'songs' && b?.kind === 'songs'
            ? a.view === b.view
            : true;
  const samePlace = (a: Place | undefined, b: Place) =>
    a?.tab === b.tab && sameDetail(a?.detail ?? null, b.detail);
  const [nav, setNav] = useState<{ stack: Place[]; index: number }>({
    stack: [{ tab: 'home', detail: null }],
    index: 0,
  });
  const place = nav.stack[nav.index] ?? { tab: 'home', detail: null };
  const detail = place.detail;
  const tab = place.tab;
  const canBack = nav.index > 0;
  const canForward = nav.index < nav.stack.length - 1;

  // Opening a place truncates any forward history and pushes the new view, the
  // way a browser does. Reopening the current view is a no-op.
  // A long session visits a lot of places; keep the back-history bounded so
  // the stack cannot grow without limit. The cap is generous - far past any
  // real back-button reach - and only ever drops the oldest entries.
  const NAV_HISTORY_CAP = 100;
  const push = (next: Place) =>
    setNav((s) => {
      if (samePlace(s.stack[s.index], next)) return s;
      let stack = s.stack.slice(0, s.index + 1);
      stack.push(next);
      if (stack.length > NAV_HISTORY_CAP) stack = stack.slice(stack.length - NAV_HISTORY_CAP);
      return { stack, index: stack.length - 1 };
    });
  /** An artist page, opened inside whichever tab is current. */
  const go = (next: string | null) =>
    push({ tab, detail: next === null ? null : { kind: 'artist', artist: next } });
  /** A playlist page, likewise stacked inside the current tab. */
  const goPlaylist = (id: string) => push({ tab, detail: { kind: 'playlist', id } });
  /** A whole-collection song page - Liked or every song - stacked the same way.
   *  The library's own views, opened full instead of in a sheet. */
  const goSongs = (view: SongCollection) => push({ tab, detail: { kind: 'songs', view } });
  /** Steps off a detail page back to its tab's root - what a deleted playlist
   *  does, since there is no page left to stand on. */
  const closeDetail = () => push({ tab, detail: null });
  /** A primary tab, from the nav bar - always lands on the tab's root. Accepts
   *  the core 'home'/'library' and any plugin page key. */
  const goTab = (next: string) => push({ tab: next, detail: null });
  const back = () => setNav((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s));
  // The phone's edge-swipe back: a drag in from the left walks the same stack
  // the header arrows do, with the page following the thumb. Touch-only and
  // edge-only (the hook guards both), and enabled only when there is anywhere
  // to go back TO - with the stack at its root the edge belongs to the page.
  const swipeRef = useRef<HTMLElement | null>(null);
  useSwipeBack(swipeRef, back, !DESKTOP && nav.index > 0);
  // The phone's back gesture: a drag in from the left edge, with the page
  // following the thumb. Only armed when there is somewhere to go back TO -
  // otherwise the whole screen would slide and then think better of it.
  const bodyRef = useRef<HTMLDivElement>(null);
  useSwipeBack(bodyRef, back, nav.index > 0);
  const forward = () => setNav((s) => (s.index < s.stack.length - 1 ? { ...s, index: s.index + 1 } : s));

  // The SYSTEM back gesture (Android hands it in through systemBack.ts): walk
  // the same stack the header arrows and the edge-swipe do. Registered once at
  // mount - before any overlay can open - so it sits at the bottom of the
  // handler stack: sheets and modals get the gesture first, this catches what
  // is left, and an unconsumed back at the root lets native background the app.
  // The ref keeps the one registered closure reading live nav state.
  const sysBackRef = useRef({ canBack, back });
  sysBackRef.current = { canBack, back };
  useEffect(
    () =>
      onSystemBack(() => {
        if (!sysBackRef.current.canBack) return false;
        sysBackRef.current.back();
        return true;
      }),
    [],
  );

  // The chord the field advertises: Cmd/Ctrl+K opens search from anywhere.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        goTab('search');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <LocaleProvider locale="en">
      {/* The provider's delegated per-press tick is OFF: a buzz on every tap
          and on cards rippling in read as force feedback, not feel. The
          semantic moments that stay (favourite, transport, disc physics,
          swipe-back) fire fireNativeHaptic directly, gated by the haptics
          preference - so `enabled={false}` silences only the kit's own listener,
          not those. The impl stays for any kit surface that asks via useHaptics.

          The app-wide tap tick is OURS instead (installTapHaptics, below): the
          kit fires on pointerdown, and a scroll starts with a pointerdown, so
          its version buzzed the whole way down a flicked shelf. Ours waits for
          the finger to lift near where it landed, which is the only moment a
          tap can be told apart from a drag. */}
      <HapticsProvider enabled={false} impl={hapticsImpl}>
        <ToastProvider>
          <AppearanceProvider>
            {/* Which server (if any) is connected sits above the library,
                because which library the app is showing is downstream of that
                answer - and a connect or disconnect should rebuild the list
                below rather than blend two libraries together. It also sits
                above the plugin registry, which filters server-backed plugins
                (the importer on a phone) on the live session. */}
            {/* Identity is the outer layer: who you are (a central registry
                account) sits above which library you are playing from (a
                server session), because an account can exist with no server
                and a server is reached by an account. */}
            <RegistrySessionProvider>
            <ServerSessionProvider>
            {/* The phone's front door: with no local library of its own, a
                mobile build gates the whole app behind a server sign-in and
                shows nothing else until one is connected. Desktop keeps its
                local library and passes straight through. */}
            <MobileAuthGate>
            {/* Who is running sits above the library while the plugins' own
                providers mount inside it, so a plugin (the importer, say) can
                read and rescan the library. */}
            <PluginsProvider>
            <LibraryProvider>
            {/* The user's own playlists: storage only, so it sits beside the
                library rather than inside it - the showcase and the song
                table resolve its paths against whichever library is live. */}
            <PlaylistsProvider>
            {/* Keeps the local music folder reconciled with the connected
                server - the up half of the hub model. Above the plugins so
                the importer can kick a pass when a download lands. */}
            <LibrarySyncProvider>
            <PluginProviders>
            <EqualizerProvider>
            {/* The playback settings - crossfade, shuffle manners, the sleep
                timer - read by the player below and by the settings modal. */}
            <PlaybackProvider>
            {/* AttackFM Connect: the device registry and shared playback
                session, so any signed-in device can see and drive what is
                playing on any other. Inert (no socket) off a server. Wraps the
                player, which registers as this device's executor. */}
            <PlaybackSyncProvider>
            <JamProvider>
            {/* The loudness reading the player publishes and the header moves
                to. It wraps both, which is the whole reason it exists. */}
            <NowPlayingMotionProvider>
            {/* The acquire hub: gathers every enabled plugin's "get this"
                handlers so any Add control gates on whether one exists, fires
                the lone one, or lets the user choose among several. Inside the
                plugin providers (a handler reads its own plugin's context) and
                above the content that carries Add controls. */}
            <AcquireProvider>
            {/* Queue editing (Play next / Add to queue) for every track surface
                below - onto this deck's queue, or, when following a jam, into
                the room the host folds it into. */}
            <QueueControlsBridge localPlayNext={playNext} localAddToQueue={addToQueue}>
            {/* The station feeds the one queue rather than keeping its own -
                see radio.tsx. It wraps the CONTENT as well as the deck: a
                song offers to start a station wherever it is drawn, and a
                menu outside this provider would silently lack the item. */}
            <RadioProvider queue={queue} onExtend={extendQueue}>
            {/* Every bottom clearance in the app is spent from
                --app-player-height, and app.css collapses that one variable to
                0 when no strip is mounted, which gives the lists their rows
                back without a rule per surface. It asks the DOM for the strip
                rather than taking a flag from here: `current` is only THIS
                device's deck, and the strip also shows for a track playing on
                another one. */}
            <div className="appWindow">
            {/* The playing track's cover, blurred and faded, behind the top of
                the WINDOW - a desktop flourish, where there is room for the
                album to sit behind a header without crowding anything.

                Off the desktop it is gone. On a phone the same wash covers the
                whole screen, so the cover and its lyric words ended up behind
                the library, the downloads queue, settings - every page, whether
                or not that page had anything to do with the song. The artwork
                belongs to Now Playing, which paints its own backdrop, and every
                other page reads better on the flat background it was designed
                against. */}
            {DESKTOP && current?.artwork && (
              // Keyed on the path so a track change starts the new cover's own
              // drift from the top rather than picking up the last one's phase.
              <NowPlayingBackdrop key={current.path} artwork={current.artwork} seed={current.path} />
            )}
            {DESKTOP && (
              // The title bar doubles as the window drag region; the inset
              // reserves the gutter the macOS traffic lights are painted into,
              // and the wordmark sits in the start slot right beside them.
              <TitleBar
                className="appTitleBar"
                data-tauri-drag-region
                surface
                border
                trafficLightInset
                start={
                  // Back and forward live left of the wordmark in a reserved
                  // slot that is always present, so the top bar's layout - and
                  // the logo's position - is identical on every page. The
                  // controls disable rather than disappear at the ends of the
                  // history, keeping the width fixed.
                  <>
                    <span className="titleBarNav">
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Back"
                        disabled={!canBack}
                        onClick={back}
                      >
                        <ChevronLeft size={18} />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Forward"
                        disabled={!canForward}
                        onClick={forward}
                      >
                        <ChevronRight size={18} />
                      </IconButton>
                    </span>
                    <img
                      className="titleBarLogo"
                      src={wordmark}
                      alt={APP_NAME}
                      // Carries the attribute itself so pressing the logo still
                      // drags the window rather than dead-zoning the bar.
                      data-tauri-drag-region
                    />
                  </>
                }
                // Search now lives on the pages themselves (Home, Library, and
                // Discover each carry their own field), so the chrome's end slot
                // is just plugin actions and settings. ⌘K still opens the global
                // palette from anywhere for those who reach for it.
                end={
                  <>
                    {/* Plugin actions have moved to the pages themselves, beside
                        the heading they act on, so the chrome's end slot is
                        settings alone. */}
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label="Settings"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <Settings size={16} />
                    </IconButton>
                  </>
                }
              />
            )}
            {!DESKTOP && (
              // The same cluster the title bar carries, in a plain header, for
              // every surface that has no window to decorate: the phone builds
              // and the browser. Without it the settings button - and so the
              // whole server connection - is unreachable off the desktop, which
              // is exactly backwards for the platform that needs a server most.
              <header className="mobileHeader">
                <span className="mobileHeader__nav">
                  {/* The desktop back/forward pair lives in a title bar this
                      build does not render, so the phone carries its own. Both
                      are always present in a fixed slot - the layout never
                      shifts - and each greys out (disabled) at its end of the
                      history rather than disappearing, so an artist page always
                      has a way out and a step back is a step you can retrace. */}
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Back"
                    disabled={!canBack}
                    onClick={back}
                  >
                    <ChevronLeft size={18} />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Forward"
                    disabled={!canForward}
                    onClick={forward}
                  >
                    <ChevronRight size={18} />
                  </IconButton>
                  {tab === 'library' ? (
                    <span className="mobileHeader__title">Library</span>
                  ) : tab === 'downloads' ? (
                    <span className="mobileHeader__title">Downloads</span>
                  ) : tab === 'profile' || tab === 'friends' ? (
                    <span className="mobileHeader__title">Profile</span>
                  ) : (
                    <img className="mobileHeader__logo" src={wordmark} alt={APP_NAME} />
                  )}
                </span>
                {/* Downloads and Settings moved off the header into the bar's
                    ⋮ menu (NavMoreMenu), so the top is just where you are. */}
                <span className="mobileHeader__actions" />
              </header>
            )}
            <div className="appBody" ref={bodyRef}>
              {/* Desktop's primary navigation: a slim icon rail beside the
                  content. The phone gets the bottom tab bar below instead -
                  same items, the shape each platform holds naturally. Both are
                  the one PrimaryNav, which folds in each plugin's page. */}
              {DESKTOP && (
                <PrimaryNav
                  variant="rail"
                  tab={tab}
                  onTab={goTab}
                  onSettings={() => setSettingsOpen(true)}
                />
              )}
              {/* Provides the arm-and-play verb to Discover/Search so a tapped,
                  not-yet-owned song opens Now Playing downloading. */}
              {/* The DJ's transcript lives HERE, above the content area, not in
                  the page: a page unmounts the moment you navigate, and a
                  conversation that forgets itself when you go and look at an
                  artist is not a conversation. */}
              <DjChatProvider onPlay={playFrom}>
              <PendingPlayProvider value={playPending}>
                <AppMain
                  swipeRef={swipeRef}
                  detail={detail}
                  tab={tab}
                  libraryView={libraryView}
                  onPlay={playFrom}
                  onOpenArtist={go}
                  onOpenPlaylist={goPlaylist}
                  onOpenSongs={goSongs}
                  onCloseDetail={closeDetail}
                  onOpenDownloads={() => goTab('downloads')}
                  onOpenStats={() => goTab('stats')}
                  onOpenFriends={() => goTab('friends')}
                />
              </PendingPlayProvider>
              </DjChatProvider>
            </div>
            {/* The phone's primary navigation: a full-width icon bar along the
                bottom, its items spread edge to edge, icon-only (the tooltip
                names each). Behind it, a progressive blur rises from the very
                bottom of the screen, so content scrolling under the nav
                dissolves into frost toward the edge rather than cutting off at
                a hard line. The scrim is aria-hidden - pure decoration. */}
            {!DESKTOP && <div className="appNavScrim" aria-hidden="true" />}
            {!DESKTOP && (
              <PrimaryNav
                variant="bar"
                tab={tab}
                onTab={goTab}
                onSettings={() => setSettingsOpen(true)}
              />
            )}
            {/* The plugins' door now lives ON the nav: a rail item per page on
                the desktop, and the phone bar's Plugins button (cascading up
                out of the bar) - see PrimaryNav. */}
            {/* Songs tapped on the car screen start here, queue and all. */}
            <CarPlayBridge onPlay={playFrom} />
            {/* Pushes the weekly listening glance to the registry while the
                stats page's share switch is on. Headless; opt-in. */}
            <ListeningShareBridge />
            {/* Teaches playFrom to route a pick to whichever device holds audio.
                Lives here, inside the Connect provider, because only a child of
                it can read the shared session. */}
            <ConnectPlayRouter routeRef={connectRouteRef} />
            {/* Watches the armed import job and, when it lands, swaps the
                downloading placeholder for the real track and plays it. Headless;
                sits inside the downloads + library providers. */}
            <PendingPlayWatcher
              jobId={pendingJobId}
              expectTitle={pendingPlaceholder?.title ?? null}
              expectArtist={pendingPlaceholder?.artist ?? null}
              onResolved={onPendingResolved}
              onFailed={onPendingFailed}
            />
            {/* No song, no strip: the app opens on its library rather than on
                a transport wired to nothing. The bar arrives with the first
                thing played and stays for the session - `current` only ever
                moves from one track to another after that, never back to
                null, so the deck is never torn down mid-listen. */}
            <PlayerHost
              current={current}
              queue={queue}
              onTrackChange={setCurrent}
              onQueueChange={setQueue}
              onOpenArtist={go}
              autoplay={autoplay}
              hidden={tab === 'date'}
            />
            <IndexingStatus />
            <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
            </div>
            </RadioProvider>
            </QueueControlsBridge>
            </AcquireProvider>
            </NowPlayingMotionProvider>
            </JamProvider>
            </PlaybackSyncProvider>
            </PlaybackProvider>
            </EqualizerProvider>
            </PluginProviders>
            </LibrarySyncProvider>
            </PlaylistsProvider>
            </LibraryProvider>
            </PluginsProvider>
            </MobileAuthGate>
            </ServerSessionProvider>
            </RegistrySessionProvider>
          </AppearanceProvider>
        </ToastProvider>
      </HapticsProvider>
    </LocaleProvider>
  );
}
