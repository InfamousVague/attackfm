// The app root. Split 2026-08: providers → nav/AppProviders, history →
// nav/useNavStack, pull-to-search → nav/useSearchSummon, content host →
// nav/AppMain, nav bars → nav/PrimaryNav, header pieces → nav/HeaderChrome,
// indexing pill → nav/IndexingStatus, strip host + Connect routing →
// player/PlayerHost, car bridge → player/CarPlayBridge. The playback state
// (current/queue) and the queue verbs stay HERE - they close over live state
// through refs and everything else threads off them.
import { IconButton, TitleBar } from '@glacier/react';
import { ArrowLeft, ArrowRight, ChevronLeft, RefreshCw, Search, Settings } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { NowPlayingBackdrop } from './player/NowPlayingBackdrop.tsx';
import { PluginHookScope } from '../plugins/runtime.tsx';
import { isDesktopApp } from './core/platform.ts';
import { useDesktopLayout } from './ux/useDesktopLayout.ts';
import type { Track } from './core/tauri.ts';
import { SettingsModal } from './settings/SettingsModal.tsx';
import { SearchPage } from './search/SearchPage.tsx';
import { SpotifyPreview } from './servers/SpotifyPreview.tsx';
import { markPlaySurface } from './player/listens.ts';
import { onOpenSearchPage, type OpenSearch } from './search/SearchEntry.tsx';
import { installShelfPan } from './ux/shelfPan.ts';
import { DjChatProvider } from './booth/djChat.tsx';
import { DatePage } from './date/DatePage.tsx';
import { DjPage } from './booth/DjPage.tsx';
import { ListeningShareBridge } from './profile/listeningShare.tsx';
import { DjSetBridge } from './booth/DjSetBridge.tsx';
import {
  PendingPlayProvider,
  PendingPlayWatcher,
  isPendingPath,
} from './player/pendingPlay.tsx';
import { useSwipeBack } from './nav/useSwipeBack.ts';
import { useSystemBack } from './nav/systemBack.ts';
import { installTapHaptics, useHapticsPref } from './core/haptics.ts';
import { installOverlayGuard } from './core/overlayGuard.ts';
import { DownloadNotices } from './notify/DownloadNotices.tsx';
import { VerboseNotices } from './notify/VerboseNotices.tsx';
import { FriendNotices } from './notify/FriendNotices.tsx';
import { ShareNotices } from './notify/ShareNotices.tsx';
import { PlaylistNotices } from './notify/PlaylistNotices.tsx';
import { NewMusicNotices } from './notify/NewMusicNotices.tsx';
import { MusicDateNotices } from './notify/MusicDateNotices.tsx';
import { SharedPlaylistBridge } from './playlists/SharedPlaylistBridge.tsx';
import { JamLinkBridge } from './player/JamLinkBridge.tsx';
import { ProfileLinkBridge } from './profile/ProfileLinkBridge.tsx';
import { NotifyBell } from './notify/NotifyBell.tsx';
import { ShareServer } from './library/ShareServer.tsx';
import { CarPlayBridge } from './player/CarPlayBridge.tsx';
import { installSheetDismiss } from './player/playerDismiss.ts';
import { ConnectPlayRouter, PlayerHost } from './player/PlayerHost.tsx';
import { IndexingStatus } from './nav/IndexingStatus.tsx';
import { PrimaryNav } from './nav/PrimaryNav.tsx';
import { APP_NAME, HeaderActionButtons, HeaderIdent } from './nav/HeaderChrome.tsx';
import { AppMain } from './nav/AppMain.tsx';
import { setMixOpener } from './nav/openMix.ts';
import { setArtistDoor } from './nav/artistDoor.ts';
import { setMusicDateDoor } from './nav/musicDateDoor.ts';
import { setDownloadsDoor } from './nav/downloadsDoor.ts';
import { setDiscoverDoor } from './nav/discoverDoor.ts';
import { setPlaylistDoor } from './nav/playlistDoor.ts';
import { setDjDoor } from './nav/djDoor.ts';
import { setNowPlayingPath } from './player/nowPlayingStore.ts';
import { settingsBack } from './settings/settingsBack.ts';
import { useNavStack } from './nav/useNavStack.ts';
import { useSearchSummon } from './nav/useSearchSummon.ts';
import { PageRefreshProvider } from './nav/pageRefresh.tsx';
import { useLibrary } from './library/library.tsx';
import { AppProviders } from './nav/AppProviders.tsx';
import { useFilePlan } from './downloads/useFilePlan.ts';
import type { FileOutcome, FilePlan } from './downloads/filePlan.ts';
import wordmark from '../assets/attack-white.png';
import { deckHandoff } from './player/deckHandoff.ts';

// Window chrome only makes sense where there is a window to decorate: a desktop
// Tauri build. A phone build is inside Tauri too, but has no frame and no
// traffic lights - so it gets the plain header below instead, as does the
// browser.
/*
 * Two different questions, and conflating them is what kept the web build
 * phone-shaped on a 27-inch monitor:
 *
 *   isDesktopApp    - is this a Tauri window? (a frame, a drag region, a
 *                     traffic-light gutter, a local folder). Fixed at load.
 *   useDesktopLayout - is there room and a cursor? Changes as a browser
 *                     window is resized, so it is a hook, not a constant.
 *
 * Window chrome keys on the first; shape keys on the second.
 */

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
 * A song added from Discover, filed where it was asked to go and then shown.
 *
 * Mounted beside the nav stack rather than on Discover, because a download
 * outlives the page that started it - you add something and walk off, and the
 * import lands with that page long unmounted. Filing the song is half the job;
 * taking you to the list is the half that needs somewhere to navigate from.
 *
 * A BRIDGE rather than a call in App's own body, for the same reason
 * RefreshBridge and CarPlayBridge are: `useFilePlan` reaches for `useLibrary`,
 * App is what RENDERS the LibraryProvider, and a hook cannot read a context its
 * own component provides. Calling it from App threw
 * "useLibrary must be used within a LibraryProvider" the moment the app booted,
 * which React answers by rendering nothing at all - a black screen on launch,
 * with the whole app behind it.
 */
function FilePlanBridge({
  onArrive,
}: {
  onArrive: (plan: FilePlan, outcome: FileOutcome) => void;
}) {
  useFilePlan(onArrive);
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
  /** Bumped by the pull gesture; pages hang their own fetches off it. */
  const [refreshNonce, setRefreshNonce] = useState(0);
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
  const DESKTOP = useDesktopLayout();
  const [swipeEl, setSwipeEl] = useState<HTMLElement | null>(null);

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
    pulling,
    refreshing,
    searchOpen,
    setSearchOpen,
  } = useSearchSummon(swipeEl, async () => {
    // A pull means "re-read what I am looking at". That is the library (the
    // box re-walks its folder and we pull the delta) AND the page's own
    // fetches, which hang off this counter - see nav/pageRefresh.tsx.
    setRefreshNonce((n) => n + 1);
    await libraryRefresh.current();
  });
  // A Spotify link the phone opened here pops its own preview card now, mounted
  // as <SpotifyPreview /> inside the providers below - not the search overlay.

  // The search bars on Library and Discover. An event rather than a prop
  // because Discover is a plugin page - see SearchEntry.tsx.
  const [searchOpenWith, setSearchOpenWith] = useState<OpenSearch>({});
  useEffect(
    () =>
      onOpenSearchPage((open) => {
        setSearchOpenWith(open);
        setSearchOpen(true);
      }),
    [setSearchOpen],
  );

  /*
   * The open search page leaves the way the Now Playing sheet does: pulled
   * down as a card, springing back short of the mark, the page behind
   * resolving from a blur. One gesture module drives both, so the two sheets
   * can never drift apart in feel.
   */
  const summonDismissRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node) return;
      return installSheetDismiss(node, {
        onDismiss: () => setSearchOpen(false),
        // Nearly everything on this page is a button; see the option's note.
        dragAnywhere: true,
      });
    },
    [setSearchOpen],
  );

  const [settingsOpen, setSettingsOpen] = useState(false);
  // Which pane Settings should open ON, when a surface aims it. Nothing aims it
  // at present: the network dot's "Manage network" was the only caller, and the
  // dot has moved into About. The seam stays because the modal still takes the
  // prop and honours it - the next surface that wants to land somewhere
  // specific needs a setter, not a mechanism.
  const [settingsPane, setSettingsPane] = useState<string | null>(null);
  // A system back swipe closes Settings before it touches the page history.
  // Back out of settings ONE STEP: the pane first, the surface only once
  // there is no pane left. Same handler the header's arrow uses, so the two
  // cannot disagree about what a press means.
  const backOutOfSettings = useCallback(() => {
    // Closing the whole surface (no pane left to step back through) clears the
    // aimed pane too. Without this the target stuck: dismissing Settings with
    // the system-back gesture goes through here rather than onClose, so a
    // Downloads pane opened once - by hand, or by a playlist import that jumps
    // you to the queue - was left set, and the next plain Settings open landed
    // back on Downloads instead of the list.
    if (!settingsBack()) {
      setSettingsOpen(false);
      setSettingsPane(null);
    }
  }, []);
  // Settings, on the list where it belongs. The pane is cleared on the way in
  // as well as the way out, so a stale target from a previous open (a
  // Downloads jump, say) can never make the gear open on something other than
  // the top of Settings.
  const openSettings = useCallback(() => {
    setSettingsPane(null);
    setSettingsOpen(true);
  }, []);
  // Downloads is no longer a place you navigate to - the songs show up where
  // they will live, arriving. This opens the Settings pane that keeps the
  // full queue and the retry/cancel affordances, for when you want to look.
  const openDownloads = useCallback(() => {
    setSettingsPane('downloads');
    setSettingsOpen(true);
  }, []);
  useSystemBack(settingsOpen, backOutOfSettings);
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
  // What an update interrupted, if this launch is the far side of one. Read in
  // the initialisers below rather than in an effect, so the deck is already
  // dressed on the first paint - arriving from an update to an empty player
  // that fills in a moment later is the flicker this exists to avoid.
  const handoff = deckHandoff();
  // The track the list handed to the player; null until one is opened.
  const [current, setCurrent] = useState<Track | null>(handoff?.track ?? null);
  // Publish just the playing song's path to the lightweight store every list
  // reads, so a row anywhere can light itself without the whole track being
  // threaded down to it. See nowPlayingStore.
  useEffect(() => {
    setNowPlayingPath(current?.path ?? null);
  }, [current?.path]);
  // The list that track was opened from, in the order it was showing - what
  // the player's skips and autoplay walk through. Snapshotted at open, the
  // way a play context should be: re-sorting the table later reorders the
  // table, not the record already spinning.
  const [queue, setQueue] = useState<Track[]>(handoff?.queue ?? []);
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
  //
  // A handoff is the one launch that opens playing: the update stopped the
  // song, so restoring it is putting something back rather than starting
  // something. Deliberately NOT true here even so - the player seeks to the
  // remembered spot first and starts from there, because autoplay would drop
  // the needle at zero while the seek was still resolving.
  const [autoplay, setAutoplay] = useState(false);
  /**
   * Whether the deck is THIS SESSION'S rather than the launch seed's.
   *
   * `autoplay` cannot answer this - it means "should the track just handed
   * over start", and playPending sets it back to false for a song still
   * downloading. This is the different question of whether anybody has picked
   * anything yet, and the split view is what needs it: the seed puts a song on
   * the deck at every launch without dropping the needle, so on a fold the app
   * opened having given half the screen to a Now Playing nobody asked for,
   * showing a paused song they had not chosen.
   *
   * Sticky on purpose. Pausing is not un-picking, and a dock that collapsed
   * whenever the music stopped would move the whole layout under the reader's
   * hands - a worse fault than the one it fixes.
   */
  const [deckEngaged, setDeckEngaged] = useState(handoff !== null);
  // The import job the current placeholder waits on while a tapped remote song
  // downloads (see pendingPlay.tsx). Null when nothing is downloading.
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  // Populated by ConnectPlayRouter (which lives inside the Connect provider and
  // so can read the shared session). When another device holds audio, it routes
  // a pick to that device and returns true; playFrom then does nothing locally,
  // so the song changes on every device while control stays where it is.
  const connectRouteRef = useRef<((track: Track, context?: Track[]) => boolean) | null>(null);

  // What playFrom needs to NAME the surface without joining its dependency
  // list: tab and detail are declared below (nav stack), so they travel by a
  // ref refreshed each render - playFrom stays identity-stable.
  const stateRef = useRef<{ searchOpen: boolean; detail: { kind?: string } | null; tab: string }>({
    searchOpen: false,
    detail: null,
    tab: '',
  });

  // Identity-stable (everything it touches is a ref or a setter): playFrom
  // rides into memoized page props and the song table's column definitions,
  // so a fresh closure per render re-rendered every row on each track change.
  const playFrom = useCallback((track: Track, context?: Track[]) => {
    // Another device is the one playing: hand it the pick rather than seizing
    // playback here. The active device loads and plays it, then reports, and
    // this device (a remote) updates from that report like any other.
    if (connectRouteRef.current?.(track, context)) return;
    // Name the surface this sitting started from, for the listen ledger:
    // the search overlay outranks the page (it floats over any of them), a
    // detail page outranks its tab. Every listen until the next queue start
    // carries this - which is how the DJ finally learns whether its own
    // picks get finished or skipped.
    markPlaySurface(
      stateRef.current.searchOpen
        ? 'search'
        : (stateRef.current.detail?.kind ?? stateRef.current.tab),
    );
    setAutoplay(true);
    setDeckEngaged(true);
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
    // A tapped song still downloading IS a pick; only the needle waits.
    setDeckEngaged(true);
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
    goMix,
    goCatalog,
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

  // The one nav stack, lent to the surfaces that cannot be handed it: mix
  // cards live on Discover and in the booth, both rendered beside this stack
  // rather than inside anything holding it. Same channel headerActions uses,
  // for the same reason.
  useEffect(() => {
    setMixOpener(goMix);
    return () => setMixOpener(null);
  }, [goMix]);
  // And the artist page, for every leaf that prints a name - the queue panel,
  // the stats rows, a friend's week - none of which fifteen props of plumbing
  // was ever going to reach. See artistDoor.ts.
  useEffect(() => {
    setArtistDoor(go);
    return () => setArtistDoor(null);
  }, [go]);
  // Music Date's opener, for the invitation card on Discover - same seam
  // pattern, same reason: the layer is App's, the door is a leaf's.
  // The Downloads pane's opener, for the paste-import field that wants to take
  // you to watch a playlist land - same seam, same reason.
  useEffect(() => {
    setDownloadsDoor(openDownloads);
    return () => setDownloadsDoor(null);
  }, [openDownloads]);
  useEffect(() => {
    setMusicDateDoor(() => setDateOpen(true));
    return () => setMusicDateDoor(null);
  }, []);
  // Discover's opener, for the "new music picked for you" notification row -
  // the same module-seam trick beside it, because the bell that draws the row
  // has no prop path to the nav stack.
  useEffect(() => {
    setDiscoverDoor(() => goTab('discover'));
    return () => setDiscoverDoor(null);
  }, [goTab]);
  // A playlist's opener, for the "shared a playlist with you" and "added to"
  // rows - the bell has no prop path to goPlaylist either.
  useEffect(() => {
    setPlaylistDoor(goPlaylist);
    setDjDoor(() => setDjOpen(true));
    return () => setPlaylistDoor(null);
  }, [goPlaylist]);

  /*
   * Which of the app's two standing glyphs the header carries here.
   *
   * A detail page LENDS the header its own verbs - Play, Shuffle, a
   * collection's menu - and these two sit at the end of them. On a narrow
   * phone that is a row of the page's controls with two pieces of app
   * furniture crowding the end of it, and neither belongs to what is on
   * screen. The bell stands down on every collection page; on an artist page
   * both do, because an artist is somebody else's and offering to invite a
   * friend to MY server from their page reads as an offer to share them.
   */
  const detailKind = detail?.kind ?? null;
  const onArtist = detailKind === 'artist';
  const onCollection =
    detailKind === 'playlist' ||
    detailKind === 'mix' ||
    detailKind === 'catalog' ||
    detailKind === 'songs';
  const chromeBell = !onArtist && !onCollection;
  const chromeShare = !onArtist;

  stateRef.current = { searchOpen, detail: detail as { kind?: string } | null, tab };
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
    // Settings first: it is a modal OVER the page, so walking the page's stack
    // while it is up moves something nobody can see.
    if (settingsOpen) {
      backOutOfSettings();
      return;
    }
    if (djOpen) {
      setDjOpen(false);
      return;
    }
    back();
  }, [settingsOpen, backOutOfSettings, djOpen, back]);
  // Settings always has somewhere to go - a pane to leave, or the surface to
  // close - so the arrow must not be greyed out while it is open.
  const canGoBack = settingsOpen || djOpen || canBack;

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
      playNow={playFrom}
    >
      <PageRefreshProvider nonce={refreshNonce}>
      {/* Fills libraryRefresh with the real rescan. Without it mounted the
          ref keeps its inert initial value, and a pull-to-refresh awaits a
          function that does nothing - which is exactly what it was doing. */}
      <RefreshBridge into={libraryRefresh} />
      {/* Inside the provider, for the reason spelled out on the component. */}
      <FilePlanBridge
        onArrive={(plan, outcome) => {
          // Only a real filing earns a navigation. Taking somebody to a
          // playlist the song did not go into is worse than saying nothing -
          // the surface that ASKED says what happened, off subscribeOutcomes.
          if (outcome !== 'filed') return;
          if (plan.dest.kind === 'liked') goSongs('liked');
          else goPlaylist(plan.dest.id);
        }}
      />
      {/* A Spotify link the phone was told to open here pops its own card -
          the record, its art, Like and Add - rather than dropping into Search.
          Inside the providers because it downloads and files like Discover. */}
      <SpotifyPreview />
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
                // The one part of this bar that is about a WINDOW rather than
                // a layout: the gutter reserving room for the macOS traffic
                // lights. In a browser nobody paints those, so the inset is
                // just ~70px of dead space before the wordmark - measured, the
                // logo sat at x=104 with it on. The drag-region attribute
                // beside it needs no such guard: the kit writes it on the bar
                // regardless, and without Tauri's runtime to read it, it is an
                // inert data attribute. Everything else here - wordmark,
                // history, network light, settings - is just the top bar, and
                // the web wants all of it.
                trafficLightInset={isDesktopApp}
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
                        <ArrowLeft size={18} />
                      </IconButton>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Forward"
                        disabled={!canForward}
                        onClick={forward}
                      >
                        <ArrowRight size={18} />
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
                    {/* The news, on the one piece of chrome every page shares -
                        which is what makes "the notifications" a place rather
                        than something you had to be on the right screen to
                        catch. */}
                    <NotifyBell
                      iconSize={16}
                      onOpenDownloads={openDownloads}
                      onOpenFriends={() => goTab('profile')}
                    />
                    {/* Invite a friend: the shareable join card, at the bell's right hand -
                        a glyph beside a glyph. Hides itself with no server to join. */}
                    <ShareServer iconSize={16} />
                    <IconButton
                      variant="ghost"
                      size="sm"
                      aria-label="Settings"
                      onClick={openSettings}
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
                    <ArrowLeft size={18} />
                  </IconButton>
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label="Forward"
                    disabled={!canForward}
                    onClick={forward}
                  >
                    <ArrowRight size={18} />
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
                  {/* After the lent buttons, not before: the collection header
                      slides Play and Shuffle in and out of this slot, and a
                      bell placed ahead of them would shift sideways every time
                      a page scrolled. Last means it never moves.

                      Not on every page, though. A detail page lends this row
                      its OWN verbs - Play, Shuffle, a collection's menu - and
                      the app's two standing glyphs sit at the end of them,
                      crowding the row on a phone with app furniture that has
                      nothing to do with what is on screen. So the bell stands
                      down on collections (a playlist, a mix, a catalogue list,
                      a song collection), and on an artist page both do: an
                      artist is somebody else's, and "invite a friend to my
                      server" read as an offer to share THEM. Neither is lost -
                      the news is a page in the nav's ⋮ menu and the invite is
                      in Settings; this is about what the top of a page is
                      for. */}
                  {chromeBell && (
                    <NotifyBell
                      iconSize={18}
                      onOpenDownloads={openDownloads}
                      onOpenFriends={() => goTab('profile')}
                    />
                  )}
                  {/* Invite a friend: the shareable join card, at the bell's right hand -
                      a glyph beside a glyph. Hides itself with no server to join. */}
                  {chromeShare && <ShareServer iconSize={18} />}
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
                  onSettings={openSettings}
                  onOpenDownloads={openDownloads}
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
                  onOpenList={goCatalog}
                  onOpenSongs={goSongs}
                  onCloseDetail={closeDetail}
                  onOpenDownloads={openDownloads}
                  onOpenStats={() => goTab('stats')}
                  onOpenFriends={() => goTab('profile')}
                  profileRoom={tab === 'profile' ? profileRoom : null}
                  onProfileRoom={setProfileRoom}
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
                onSettings={openSettings}
                  onOpenDownloads={openDownloads}
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
            <DjSetBridge />
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
              deckEngaged={deckEngaged}
              hidden={dateOpen || djOpen}
            />
            {/* Turns the import queue into surfaces: a quick line at the top
                when work starts, a row behind the bell when it lands. Renders
                nothing itself - it sits here, inside the plugin providers and
                the toast provider, because that is where both halves are
                reachable. */}
            <DownloadNotices />
            {/* Same depth as DownloadNotices for the same reasons: inside the
                plugin providers, under ToastProvider. Headless. */}
            <VerboseNotices />
            {/* Not beside VerboseNotices in spirit: that one is behind the
                device's verbose switch because it is chatter about the
                machine's own work. A friend request is addressed to you and
                waits for an answer, so it rings either way. */}
            <FriendNotices />
            <ShareNotices />
            {/* The same kind of news, one step further in: a friend shared a
                LIST with you, or added to one you share. Addressed, so it
                rings either way; polled off the hub's own ledger. */}
            <PlaylistNotices />
            {/* The discovery pair: the app's own background work - the shelf of
                new music picked for you, and the Music Date pool filling -
                turned into a nudge instead of something you had to open the
                right page to notice. Seed-silent and rise-only, behind the
                device's "Discovery notifications" switch. Headless, session is
                all either needs. */}
            <NewMusicNotices />
            <MusicDateNotices />
            <SharedPlaylistBridge />
            {/* The other two links the registry hands out. Beside the playlist
                one because they are the same kind of thing: a URL arrives, a
                modal answers it over whatever page is up. */}
            <JamLinkBridge />
            <ProfileLinkBridge />
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

            {/* What the pull is opening onto.

                The gap stops being a hole with a bar in it and becomes the top
                of the search page: the same SearchPage the overlay mounts,
                clipped to whatever the pull has uncovered, so the recents and
                the field below the bar are the real ones arriving rather than
                a picture of them.

                Mounted for the whole gesture rather than per frame - the cost
                is the mount, and paying it on every frame of a drag would cost
                the drag. `!searchOpen` keeps it exclusive with the overlay, so
                there is only ever one SearchPage alive. */}
            {/* What the pull reveals now: a turning mark in the gap the page
                opens above itself. The whole SearchPage used to be rendered
                here as a live preview, which was a second copy of the heaviest
                screen in the app mounted on a gesture; a mark is the honest
                weight for "the library is re-reading itself". Kept mounted
                while the refresh runs, so the gap does not snap shut under a
                spinner that is still spinning. */}
            {!DESKTOP && (pulling || refreshing) && !searchOpen && (
              <div className="pullMark" data-spinning={refreshing || undefined} aria-hidden="true">
                <RefreshCw size={18} />
              </div>
            )}
            {searchOpen && (
              <>
                {/* Same behind-layer the Now Playing sheet uses - the dismiss
                    gesture publishes --np-drag/data-np-dragging globally, so
                    the identical class gives the identical resolving blur. */}
                <div className="npScreen__behind" aria-hidden="true" />
              <div
                ref={summonDismissRef}
                className="searchSummon"
                role="dialog"
                aria-label="Search"
              >
                {/* The drawer's handle: a visible way out, and the honest
                    hint that this is a sheet you can pull. The gesture has
                    always worked from anywhere on the page (dragAnywhere,
                    above); the pill is affordance, not new machinery - plus
                    one tap target for the people who tap handles. */}
                <button
                  type="button"
                  className="searchSummon__handle"
                  aria-label="Close search"
                  onClick={() => setSearchOpen(false)}
                >
                  <span aria-hidden="true" />
                </button>
                <PluginHookScope>
                  <SearchPage
                    initialFilter={searchOpenWith.scope}
                    placeholder={searchOpenWith.placeholder}
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
              </>
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
      </PageRefreshProvider>
    </AppProviders>
  );
}
