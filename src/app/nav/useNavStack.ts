import { useCallback, useEffect, useRef, useState } from 'react';
import { onSystemBack } from './systemBack.ts';
import type { Detail, SongCollection } from './AppMain.tsx';
import type { Suggestion } from '../api/curator.ts';
import type { Track } from '../core/tauri.ts';

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
      : a?.kind === 'album' && b?.kind === 'album'
        ? a.album === b.album && a.artist === b.artist
      : a?.kind === 'playlist' && b?.kind === 'playlist'
        ? a.id === b.id
        : a?.kind === 'songs' && b?.kind === 'songs'
          ? a.view === b.view
          : true;
const samePlace = (a: Place | undefined, b: Place) =>
  a?.tab === b.tab && sameDetail(a?.detail ?? null, b.detail);

// A long session visits a lot of places; keep the back-history bounded so
// the stack cannot grow without limit. The cap is generous - far past any
// real back-button reach - and only ever drops the oldest entries.
const NAV_HISTORY_CAP = 100;

/**
 * The app's page history, extracted whole from App. goTab's legacy-route
 * redirects (stats/date/search became overlays or rooms) fire through the
 * injected callbacks so the hook itself stays pure navigation.
 *
 * Every returned verb is IDENTITY-STABLE (useCallback over refs): they feed
 * memoized column definitions and page props all over the app, and a fresh
 * `onOpenArtist` per render was busting the song table's column memo - and
 * with it the grid's whole-library sort - on every track change.
 */
export function useNavStack({
  openStats,
  openDate,
  openSearch,
  closeProfileRoom,
}: {
  /** The old 'stats' tab landed inside Profile's room; this opens the room. */
  openStats: () => void;
  /** The old 'date' tab opens Music Date's fullscreen layer. */
  openDate: () => void;
  /** The old 'search' tab summons the search overlay. */
  openSearch: () => void;
  /** Walking to Profile the normal way closes any open room. */
  closeProfileRoom: () => void;
}) {
  const [nav, setNav] = useState<{ stack: Place[]; index: number }>({
    stack: [{ tab: 'home', detail: null }],
    index: 0,
  });
  const place = nav.stack[nav.index] ?? { tab: 'home', detail: null };
  const detail = place.detail;
  const tab = place.tab;
  const canBack = nav.index > 0;
  const canForward = nav.index < nav.stack.length - 1;

  // The pieces the stable verbs read live: the current tab (a detail opens
  // inside it) and the injected doors, which App builds inline every render.
  const live = useRef({ tab, openStats, openDate, openSearch, closeProfileRoom });
  live.current = { tab, openStats, openDate, openSearch, closeProfileRoom };

  // Opening a place truncates any forward history and pushes the new view, the
  // way a browser does. Reopening the current view is a no-op.
  const push = useCallback((next: Place) => {
    setNav((s) => {
      if (samePlace(s.stack[s.index], next)) return s;
      let stack = s.stack.slice(0, s.index + 1);
      stack.push(next);
      if (stack.length > NAV_HISTORY_CAP) stack = stack.slice(stack.length - NAV_HISTORY_CAP);
      return { stack, index: stack.length - 1 };
    });
  }, []);
  /** An artist page, opened inside whichever tab is current. */
  const go = useCallback(
    (next: string | null) =>
      push({ tab: live.current.tab, detail: next === null ? null : { kind: 'artist', artist: next } }),
    [push],
  );
  /** An album page, likewise stacked inside the current tab. */
  const goAlbum = useCallback(
    (album: string, albumArtist: string) =>
      push({ tab: live.current.tab, detail: { kind: 'album', album, artist: albumArtist } }),
    [push],
  );
  const goPlaylist = useCallback(
    (id: string) => push({ tab: live.current.tab, detail: { kind: 'playlist', id } }),
    [push],
  );
  /** A mix - somebody else's list - stacked the same way a playlist is. */
  const goMix = useCallback(
    (title: string, tracks: Track[], emptyLabel?: string) =>
      push({ tab: live.current.tab, detail: { kind: 'mix', title, tracks, emptyLabel } }),
    [push],
  );
  /** A catalogue's own list, opened to be read before it is taken. Stacked
   *  like a mix, and for the same reason: it has no id here. */
  const goCatalog = useCallback(
    (suggestion: Suggestion) => push({ tab: live.current.tab, detail: { kind: 'catalog', suggestion } }),
    [push],
  );
  /** A whole-collection song page - Liked or every song - stacked the same way.
   *  The library's own views, opened full instead of in a sheet. */
  const goSongs = useCallback(
    (view: SongCollection) => push({ tab: live.current.tab, detail: { kind: 'songs', view } }),
    [push],
  );
  /** Steps off a detail page back to its tab's root - what a deleted playlist
   *  does, since there is no page left to stand on. */
  const closeDetail = useCallback(
    () => push({ tab: live.current.tab, detail: null }),
    [push],
  );
  /** A primary tab, from the nav bar - always lands on the tab's root. Accepts
   *  the core 'home'/'library' and any plugin page key. */
  const goTab = useCallback(
    (next: string) => {
      // Stats folded into Profile as a room; its old tab name still arrives
      // from older surfaces (the Library's stats cards) and lands inside the
      // room it became, so no caller had to learn the move.
      if (next === 'stats') {
        live.current.openStats();
        push({ tab: 'profile', detail: null });
        return;
      }
      // Music Date moved twice - overflow menu, Profile room, and now the
      // Booth's top card. The old route opens its fullscreen layer wherever
      // you already are.
      if (next === 'date') {
        live.current.openDate();
        return;
      }
      // The DJ page became the Booth; the old name still walks in the door.
      if (next === 'dj') {
        push({ tab: 'booth', detail: null });
        return;
      }
      // Search stopped being a place: the old route now summons the overlay
      // over wherever you already are.
      if (next === 'search') {
        live.current.openSearch();
        return;
      }
      // Books moved into the Library (a Music/Books toggle), so its old page
      // route lands on the Library now - the shelf is a tap away there.
      if (next.startsWith('books:')) {
        push({ tab: 'library', detail: null });
        return;
      }
      // Friends folded back into Profile, so the old Friends route lands there
      // - the grid is under your own profile now.
      if (next === 'friends') {
        live.current.closeProfileRoom();
        push({ tab: 'profile', detail: null });
        return;
      }
      // Walking to Profile the normal way always lands on the profile itself.
      if (next === 'profile') live.current.closeProfileRoom();
      push({ tab: next, detail: null });
    },
    [push],
  );
  const back = useCallback(
    () => setNav((s) => (s.index > 0 ? { ...s, index: s.index - 1 } : s)),
    [],
  );
  const forward = useCallback(
    () => setNav((s) => (s.index < s.stack.length - 1 ? { ...s, index: s.index + 1 } : s)),
    [],
  );

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

  return {
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
  };
}
