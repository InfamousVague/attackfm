// The app root. Split 2026-08: providers → nav/AppProviders, history →
// nav/useNavStack, pull-to-search → nav/useSearchSummon, content host →
// nav/AppMain, nav bars → nav/PrimaryNav, header pieces → nav/HeaderChrome,
// indexing pill → nav/IndexingStatus, strip host + Connect routing →
// player/PlayerHost, car bridge → player/CarPlayBridge. The playback state
// (current/queue) and the queue verbs stay HERE - they close over live state
// through refs and everything else threads off them.
import { IconButton, SearchField, TitleBar } from '@glacier/react';
import { ChevronLeft, ChevronRight, RefreshCw, Search, Settings, X } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NowPlayingBackdrop } from './player/NowPlayingBackdrop.tsx';
import { PluginHookScope } from '../plugins/runtime.tsx';
import { isDesktopApp } from './core/platform.ts';
import type { Track } from './core/tauri.ts';
import { NetworkDot } from './servers/NetworkDot.tsx';
import { SettingsModal } from './settings/SettingsModal.tsx';
import { SearchPage } from './search/SearchPage.tsx';
import { installShelfPan } from './ux/shelfPan.ts';
import { DjChatProvider } from './booth/djChat.tsx';
import { DatePage } from './date/DatePage.tsx';
import { DjPage } from './booth/DjPage.tsx';
import { ListeningShareBridge } from './profile/listeningShare.tsx';
import {
  PendingPlayProvider,
  PendingPlayWatcher,
  isPendingPath,
} from './player/pendingPlay.tsx';
import { useSwipeBack } from './nav/useSwipeBack.ts';
import { useSystemBack } from './nav/systemBack.ts';
import { installTapHaptics, useHapticsPref } from './core/haptics.ts';
import { installOverlayGuard } from './core/overlayGuard.ts';
import { DownloadsChip } from './downloads/DownloadsChip.tsx';
import { CarPlayBridge } from './player/CarPlayBridge.tsx';
import { ConnectPlayRouter, PlayerHost } from './player/PlayerHost.tsx';
import { IndexingStatus } from './nav/IndexingStatus.tsx';
import { PrimaryNav } from './nav/PrimaryNav.tsx';
import { APP_NAME, HeaderActionButtons, HeaderIdent } from './nav/HeaderChrome.tsx';
import { AppMain } from './nav/AppMain.tsx';
import { useNavStack } from './nav/useNavStack.ts';
import { useSearchSummon } from './nav/useSearchSummon.ts';
import { useLibrary } from './library/library.tsx';
import { AppProviders } from './nav/AppProviders.tsx';
import wordmark from '../assets/attack-white.png';

// Window chrome only makes sense where there is a window to decorate: a desktop
// Tauri build. A phone build is inside Tauri too, but has no frame and no
// traffic lights - so it gets the plain header below instead, as does the
// browser.
const DESKTOP = isDesktopApp;

/**
 * Lends App the library's rescan.
 *
 * A pull-to-refresh has to reach the thing that re-reads the library, and
 * that lives under the provider App itself renders. Holding it in state would
 * re-render the whole shell every time the library object changes; a ref
 * costs nothing, and the gesture only reads it at the moment of release.
 */
function RefreshBridge({ into }: { into: React.MutableRefObject<() => Promise<void>> }) {
  const { rescan } = useLibrary();
  useEffect(() => {
    into.current = async () => {
      await rescan();
    };
  }, [rescan, into]);
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
  // Which of Profile's rooms is open - This week (stats). Lives here rather
  // than in ProfilePage because the old 'stats' TAB redirects into the room
  // so every stored link keeps working.
  const [profileRoom, setProfileRoom] = useState<'stats' | null>(null);
  // A system back swipe inside a room steps back to Profile, not out of it.
  useSystemBack(profileRoom !== null, () => setProfileRoom(null));
  // Music Date, fullscreen: opened from the Booth's top card as a layer over
  // whatever you stand on. The nav bar and the player both leave with it -
  // the date runs its own audio pool and wants the whole screen, no chrome.
  const [dateOpen, setDateOpen] = useState(false);
  useSystemBack(dateOpen, () => setDateOpen(false));
  // The DJ conversation's fullscreen layer lives HERE, not in BoothPage: the
  // page host wears a transform for the edge-swipe, which traps any fixed
  // child in its stacking context - a "fullscreen" layer that the header,
  // strip and nav all paint over. At the root it actually covers the app,
  // and the chrome steps aside the same way it does for Music Date.
  const [djOpen, setDjOpen] = useState(false);
  useSystemBack(djOpen, () => setDjOpen(false));
  // The edge-swipe back gesture's drag target: AppMain's content host. Owned
  // here because the pull-to-search gesture listens on the same element. Held
  // in STATE, not a ref: on a fresh phone the onboarding gate renders instead
  // of AppMain, so the host does not exist when this component's effects first
  // run - the gesture hooks have to re-attach when it finally mounts, which
  // only a state-carried node can tell them.
  const [swipeEl, setSwipeEl] = useState<HTMLElement | null>(null);
  /*
   * The settled gap, taken from the bar itself.
   *
   * It used to be a hardcoded 3.1rem, which is a guess about a component this
   * file does not own: the kit is free to change SearchField's height, a
   * larger system font grows it, and the moment the guess is short the page
   * does not move far enough and the bar sits on top of the music - exactly
   * the thing this whole change was meant to stop. Measured, it cannot be
   * wrong.
   */
  const barRef = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    const write = () => {
      const h = node.getBoundingClientRect().height;
      if (h > 0) document.documentElement.style.setProperty('--app-pull-stand', `${h + 10}px`);
    };
    write();
    const ro = new ResizeObserver(write);
    ro.observe(node);
    return () => ro.disconnect();
  }, []);
  const swipeRef = useCallback((node: HTMLElement | null) => setSwipeEl(node), []);
  /*
   * What a full pull refreshes. App renders the LibraryProvider, so it cannot
   * call useLibrary itself; the bridge below fills this ref, and the gesture
   * reads it. Inert until then, so a pull during boot does nothing rather
   * than throwing.
   */
  const libraryRefresh = useRef<() => Promise<void>>(async () => {});
  // Search, summoned: pull down on any page (or ⌘K) - state, gesture and
  // chord live in useSearchSummon.
  const {
    stage,
    barOpen,
    setBarOpen,
    refreshing,
    summonHint,
    searchOpen,
    setSearchOpen,
  } = useSearchSummon(swipeEl, () => libraryRefresh.current());
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which pane Settings should open ON, when a surface aims it - the network
  // dot's Manage lands on Servers; a plain open starts wherever it was.
  const [settingsPane, setSettingsPane] = useState<string | null>(null);
  const openSettings = (pane: string | null = null) => {
    setSettingsPane(pane);
    setSettingsOpen(true);
  };
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

  // Identity-stable (everything it touches is a ref or a setter): playFrom
  // rides into memoized page props and the song table's column definitions,
  // so a fresh closure per render re-rendered every row on each track change.
  const playFrom = useCallback((track: Track, context?: Track[]) => {
    // Another device is the one playing: hand it the pick rather than seizing
    // playback here. The active device loads and plays it, then reports, and
    // this device (a remote) updates from that report like any other.
    if (connectRouteRef.current?.(track, context)) return;
    setAutoplay(true);
    setCurrent((prev) => (prev === track ? { ...track } : track));
    setQueue(context ?? [track]);
  }, []);

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
  // The page history - the stack, the go* verbs and the system-back catch-all
  // - lives in useNavStack; the legacy-route redirects land back here as
  // callbacks because the rooms and overlays they open are App's state.
  const {
    detail,
    tab,
    canBack,
    canForward,
    go,
    goAlbum,
    goPlaylist,
    goSongs,
    closeDetail,
    goTab,
    back,
    forward,
  } = useNavStack({
    openStats: () => setProfileRoom('stats'),
    openDate: () => setDateOpen(true),
    openSearch: () => setSearchOpen(true),
    closeProfileRoom: () => setProfileRoom(null),
  });
  // The phone's edge-swipe back: a drag in from the left walks the same stack
  // the header arrows do, with the page following the thumb. Touch-only and
  // edge-only (the hook guards both), and enabled only when there is anywhere
  // to go back TO - with the stack at its root the edge belongs to the page.
  /*
   * Back, for everything that is a step.
   *
   * The DJ conversation is an overlay rather than a history entry, so the
   * header's own arrow knew nothing about it and the layer had to float a
   * second chevron of its own - two back buttons in the same corner, one of
   * them the app's and one of them not. The header's arrow is the app's one
   * way back on every page; when the conversation is up, it closes the
   * conversation, and there is nothing else to draw.
   */
  const backFromAnywhere = useCallback(() => {
    if (djOpen) {
      setDjOpen(false);
      return;
    }
    back();
  }, [djOpen, back]);
  const canGoBack = djOpen || canBack;

  useSwipeBack(swipeEl, backFromAnywhere, !DESKTOP && canGoBack);

  /*
   * The header's real height, published for the layers that must begin below
   * it. Measured rather than assumed: it carries the notch inset, and a
   * foldable changes both when it opens - a hardcoded number is wrong on
   * exactly the device this app is used on. Observed rather than measured
   * once, for the same reason.
   */
  const [headerEl, setHeaderEl] = useState<HTMLElement | null>(null);
  const headerRef = useCallback((node: HTMLElement | null) => setHeaderEl(node), []);
  useEffect(() => {
    if (!headerEl) return;
    const publish = () =>
      document.documentElement.style.setProperty(
        '--app-header-height',
        `${Math.round(headerEl.getBoundingClientRect().height)}px`,
      );
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(headerEl);
    return () => observer.disconnect();
  }, [headerEl]);

  // Sideways drags on shelves, which the engine no longer performs itself -
  // see shelfPan.ts and the touch-action rule it pairs with. Delegated from
  // the document, so every shelf on every page is covered by this one line.
  useEffect(() => installShelfPan(), []);

  return (
    <AppProviders
      queue={queue}
      extendQueue={extendQueue}
      playNext={playNext}
      addToQueue={addToQueue}
    >
      {/* Fills libraryRefresh with the real rescan. Without it mounted the
          ref keeps its inert initial value, and a pull-to-refresh awaits a
          function that does nothing - which is exactly what it was doing. */}
      <RefreshBridge into={libraryRefresh} />
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
                        disabled={!canGoBack}
                        onClick={backFromAnywhere}
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
                        the heading they act on, so the chrome's end slot is the
                        network light and settings. */}
                    <NetworkDot onManage={() => openSettings('server')} />
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
              <header className="mobileHeader" ref={headerRef}>
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
                    disabled={!canGoBack}
                    onClick={backFromAnywhere}
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
                  <HeaderIdent tab={tab} />
                </span>
                {/* Downloads and Settings moved off the header into the bar's
                    ⋮ menu (NavMoreMenu), so the top is just where you are -
                    which left this slot free for the page below to borrow.
                    A song collection puts Play and Shuffle here once its own
                    header has scrolled away: the collapsed strip down there is
                    3rem holding a mark, a name, a pill and an icon, and this
                    row is already taller with its trailing half empty. */}
                <span className="mobileHeader__actions">
                  <HeaderActionButtons />
                  <NetworkDot onManage={() => openSettings('server')} />
                </span>
              </header>
            )}
            <div className="appBody">
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
                  onOpenAlbum={goAlbum}
                  onOpenPlaylist={goPlaylist}
                  onOpenSongs={goSongs}
                  onCloseDetail={closeDetail}
                  onOpenDownloads={() => goTab('downloads')}
                  onOpenStats={() => goTab('stats')}
                  onOpenFriends={() => goTab('friends')}
                  profileRoom={tab === 'profile' ? profileRoom : null}
                  onProfileRoom={setProfileRoom}
                  onOpenDate={() => setDateOpen(true)}
                  onOpenDj={() => setDjOpen(true)}
                />
            {/* The DJ conversation, fullscreen: same layer, same rules. One
                back control only - this layer covers the header, so its
                floating chevron (or the system back) is the single way out. */}
            {/* The conversation sits UNDER the header rather than over it, so
                the app's own back arrow is the way out - see backFromAnywhere.
                It used to cover the header and float a chevron of its own,
                which put two back buttons in the same corner. */}
            {djOpen && (
              <div className="dateLayer djLayer">
                <DjPage />
              </div>
            )}
              </PendingPlayProvider>
              </DjChatProvider>
            </div>
            {/* The phone's primary navigation: a full-width icon bar along the
                bottom, its items spread edge to edge, icon-only (the tooltip
                names each). Behind it, a progressive blur rises from the very
                bottom of the screen, so content scrolling under the nav
                dissolves into frost toward the edge rather than cutting off at
                a hard line. The scrim is aria-hidden - pure decoration. */}
            {!DESKTOP && !dateOpen && !djOpen && <div className="appNavScrim" aria-hidden="true" />}
            {!DESKTOP && !dateOpen && !djOpen && (
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
              hidden={dateOpen || djOpen}
            />
            {/* The import queue's one door: floats above the strip while
                work is in flight or needs a hand, gone when idle. */}
            <DownloadsChip open={() => goTab('downloads')} current={tab === 'downloads'} />
            {/* Music Date, fullscreen: over everything, chrome gone - no nav
                bar, no player strip, just the introductions. A floating
                chevron (and the system back) is the way out. */}
            {dateOpen && (
              <div className="dateLayer">
                <button
                  type="button"
                  className="dateLayer__close"
                  aria-label="Leave Music Date"
                  onClick={() => setDateOpen(false)}
                >
                  <ChevronLeft size={20} />
                </button>
                <DatePage />
              </div>
            )}
            <IndexingStatus />
            {/* Summoned search: over whatever you were doing, gone the same
                way. The page inside is the same SearchPage the old tab held -
                results, recents, paste-a-link import - inside a plugin hook
                scope because a pasted link is a plugin's action. Navigating
                OUT of a result closes the overlay; playing keeps it up. */}
            {/*
                The pull, drawn.

                The deck is the GAP the page leaves as it slides down - it is
                sized by the same --app-pull the page is moved by, so the bar
                is uncovered rather than laid over anything. It stays mounted
                whenever there is something to uncover: a live gesture, a
                standing bar, or a refresh in flight.

                Stage one: the search bar is revealed and left standing when
                the finger lifts - a door to be tapped, not a flash. Stage two:
                the refresh mark takes the gap over, and takes the release.
             */}
            {!DESKTOP && (stage !== 'idle' || barOpen || refreshing) && (
              <div
                className="pullDeck"
                data-stage={refreshing ? 'refresh' : stage}
                data-spinning={refreshing || undefined}
              >
                {/* The kit's own SearchField, not a button dressed as one:
                    this is the same control the search page itself wears, so
                    it carries the kit's height, radius, focus ring and glass.
                    It is inert here - the field never takes a keystroke, the
                    wrapper takes the tap and hands the whole gesture to the
                    search page, where a real field is waiting focused. */}
                <div
                  ref={barRef}
                  className="pullDeck__search"
                  role="button"
                  tabIndex={0}
                  aria-label="Search your library"
                  onClick={() => {
                    setBarOpen(false);
                    setSearchOpen(true);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      setBarOpen(false);
                      setSearchOpen(true);
                    }
                  }}
                >
                  <SearchField
                    size="lg"
                    placeholder="Search your library"
                    tabIndex={-1}
                    aria-hidden="true"
                    readOnly
                  />
                </div>
                <span
                  className="pullDeck__refresh"
                  aria-hidden={!refreshing}
                  role={refreshing ? 'status' : undefined}
                >
                  <RefreshCw size={16} />
                  <span className="pullDeck__word">
                    {refreshing ? 'Refreshing…' : 'Release to refresh'}
                  </span>
                </span>
              </div>
            )}
            {summonHint && !DESKTOP && !searchOpen && (tab === 'home' || tab === 'library') && (
              <button
                type="button"
                className="summonHintChip"
                onClick={() => setSearchOpen(true)}
              >
                <Search size={13} /> Pull down for search · further to refresh
              </button>
            )}
            {searchOpen && (
              <div className="searchSummon" role="dialog" aria-label="Search">
                <div className="searchSummon__bar">
                  <span className="searchSummon__grab" aria-hidden="true" />
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Close search"
                    className="searchSummon__close"
                    onClick={() => setSearchOpen(false)}
                  >
                    <X size={18} />
                  </IconButton>
                </div>
                <PluginHookScope>
                  <SearchPage
                    onPlay={playFrom}
                    onOpenArtist={(artist) => {
                      setSearchOpen(false);
                      go(artist);
                    }}
                    onOpenAlbum={(album, albumArtist) => {
                      setSearchOpen(false);
                      goAlbum(album, albumArtist);
                    }}
                    onOpenPlaylist={(id) => {
                      setSearchOpen(false);
                      goPlaylist(id);
                    }}
                  />
                </PluginHookScope>
              </div>
            )}
            <SettingsModal
              open={settingsOpen}
              onClose={() => {
                setSettingsOpen(false);
                setSettingsPane(null);
              }}
              pane={settingsPane}
            />
            </div>
    </AppProviders>
  );
}
