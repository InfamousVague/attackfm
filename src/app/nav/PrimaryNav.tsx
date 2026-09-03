import { NavBar, NavBarItem } from '@glacier/react';
import { useNavPill } from './useNavPill.ts';
import { CircleUserRound, Disc3, LibraryBig, Search, Telescope } from '@glacier/icons';
import { useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { atSize, useNavSeats, type NavDest } from './navSeats.ts';
import { useAcquire, usePluginPages } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { NavMoreMenu } from './NavMoreMenu.tsx';
import { openSearchPage } from '../search/SearchEntry.tsx';
import { useDeveloperMode } from '../settings/developerMode.ts';

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
export function PrimaryNav({
  variant,
  tab,
  onTab,
  onSettings,
  onOpenDownloads,
}: {
  variant: 'rail' | 'bar';
  /** The active tab: 'home', 'library', or a plugin page's `${id}:${page}` key. */
  tab: string;
  onTab: (tab: string) => void;
  onSettings: () => void;
  /** Opens the Downloads settings pane (Downloads is no longer a destination). */
  onOpenDownloads: () => void;
  /** Opens the full-screen search. Never a tab - it is an overlay over
   *  whatever you were doing, and it gives that page back when it closes. */
}) {
  const pages = usePluginPages();
  // Books no longer holds a nav seat: it is a Music/Books toggle at the top of
  // the Library page now. The books plugin still owns the shelf; the Library
  // finds and renders it. So the generic plugin-page loop below skips it.
  // Downloads is a plugin surface, not a core one: the tab appears only while an
  // importer is actually running (it provides the downloads bridge). With no
  // importer - a fresh install, or anyone who has not added a plugin source -
  // there is nothing to download, so the tab is absent rather than a dead end.
  const dl = useDownloadsOptional();
  const hasDownloads = dl !== null;
  // Discover is a destination again - by request: everything the machine
  // suggests (the curated mixes, Music Date, the auditions, the charts) lives
  // there, and the Library holds only what you saved or made. The seat does
  // not depend on an importer being present: the page has plenty to show
  // without one, and hides what it cannot act on itself.
  //
  // `useAcquire` stays called here even though no seat depends on it.
  // Called unconditionally. It used to sit behind `hasDownloads ||`, so the
  // hook ran or did not depending on whether an importer was loaded - and the
  // day that flipped mid-session React would have found a different hook order
  // than it left. Nothing below may be added while that is still true.
  const acquire = useAcquire();
  // Both are still read for their hooks' sake rather than for a seat: see the
  // note above about hook order. Neither gates anything now.
  void acquire;
  void hasDownloads;
  // The Booth is a workshop, not a destination: it is behind developer mode now
  // rather than holding a seat (or a menu row) for everybody.
  const showBooth = useDeveloperMode();
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
    (tab !== 'downloads' &&
      tab !== 'discover' &&
      tab !== 'friends' &&
      tab !== 'profile' &&
      tab !== 'search' &&
      // Built-in pages that own their own route. Without these the deny-list
      // lights Library while you are standing in the Booth - the trap of
      // listing what is NOT library instead of what is. (Stats and Date are
      // Profile's rooms now, not tabs.)
      tab !== 'booth' &&
      !onPluginPage);

  /*
   * EVERY destination the phone bar can offer, in the order it gives them up.
   *
   * One list, ordered by how much a seat is worth to it, and the bar simply
   * takes as many as it has room for. What is left goes to the ⋮ - so the menu
   * is the overflow rather than a second, hand-kept list of its own, and a
   * destination cannot end up in both hands or neither.
   *
   * The order is the old menu's order, which means the thing that was at the
   * top of ⋮ is the thing that comes out of it first.
   */
  const barRef = useRef<HTMLElement | null>(null);
  // The lit plate slides between tabs rather than blinking from one to the
  // next - see useNavPill. Bar only; the desktop rail is a kit NavBar and
  // already has the kit's own sliding indicator.
  useNavPill(barRef);
  const dests = useMemo<NavDest[]>(() => {
    const list: NavDest[] = [
      // Discover FIRST, by request: what the machine has for you leads the bar.
      {
        key: 'discover',
        label: 'Discover',
        icon: <Telescope size={24} />,
        active: tab === 'discover',
        go: () => onTab('discover'),
      },
      /*
       * Search second. Never ACTIVE, because it is not a place: it opens the
       * drawer over whatever you were doing and gives the page back when it
       * closes. openSearchPage is the same global door the on-page bars use,
       * so there is still exactly one way in.
       */
      {
        key: 'search',
        label: 'Search',
        icon: <Search size={24} />,
        active: false,
        go: () => openSearchPage(),
      },
      // Then the Library - what you kept and made. Books used to hold a seat
      // of their own here; they are a Music/Books toggle at the top of the
      // Library now, so the shelf and the songs share one destination.
      {
        key: 'library',
        label: 'Library',
        icon: <LibraryBig size={24} />,
        active: libraryActive,
        go: () => onTab('library'),
      },
    ];
    // Profile carries the people now - Friends folded back in under you, so
    // the two "people" seats became one.
    list.push({
      key: 'profile',
      label: 'Profile',
      icon: <CircleUserRound size={24} />,
      active: tab === 'profile' || tab === 'friends',
      go: () => onTab('profile'),
    });
    // Other plugin pages keep their seats; Books does not, having moved into
    // the Library's toggle.
    for (const pg of pages) {
      if (pg.pluginId === 'books') continue;
      list.push({
        key: pg.key,
        label: pg.label,
        icon: pg.icon,
        active: tab === pg.key,
        go: () => onTab(pg.key),
      });
    }
    // Last, and only for anybody who has turned developer mode on.
    if (showBooth) {
      list.push({
        key: 'booth',
        label: 'Booth',
        icon: <Disc3 size={24} />,
        active: tab === 'booth',
        go: () => onTab('booth'),
      });
    }
    return list;
  }, [pages, libraryActive, tab, onTab, showBooth]);

  const seats = useNavSeats(barRef, dests.length);
  /*
   * The ⋮ keeps a seat of its own, always. Settings lives in it and never comes
   * out - a bar seat for the cog was the same door twice - and so does the
   * download queue, so there is no width at which the menu can be dispensed
   * with. The split is therefore over the seats that are LEFT.
   *
   * Before the first measurement `seats` is null and everything is drawn. That
   * is corrected in a layout effect, which runs before the browser paints, so
   * the over-full bar is never a frame anybody sees.
   */
  const shown =
    seats === null ? dests.length : Math.max(1, Math.min(dests.length, seats - 1));
  const inBar = dests.slice(0, shown);
  const inMenu = dests.slice(shown);

  const primaryItems = (
    <>
      {/* Discover, Search, Library - the order the phone bar keeps too, by
          request: what the machine has for you, the way to look, then what you
          kept. Search opens the overlay rather than routing anywhere. */}
      <NavBarItem
        icon={<Telescope size={24} />}
        label="Discover"
        active={tab === 'discover'}
        onClick={() => onTab('discover')}
      />
      <NavBarItem
        icon={<Search size={24} />}
        label="Search"
        active={false}
        onClick={() => openSearchPage()}
      />
      {/* Library: the music you saved or made, and - behind its own Music/Books
          toggle - your audiobook shelf. Books no longer holds a rail seat. */}
      <NavBarItem
        icon={<LibraryBig size={24} />}
        label="Library"
        active={libraryActive}
        onClick={() => onTab('library')}
      />
      {/* Downloads is NOT a nav destination. On the phone it is an icon on the
          library page (where the music it is fetching ends up); on the desktop
          it is the chip above the player strip, and only while something is
          actually in flight. A queue you visit occasionally does not deserve a
          permanent seat in a bar of four. */}
      {/* Developer mode only, on the rail as in the bar. */}
      {showBooth && (
        <NavBarItem
          icon={<Disc3 size={24} />}
          label="Booth"
          active={tab === 'booth'}
          onClick={() => onTab('booth')}
        />
      )}
      <NavBarItem
        icon={<CircleUserRound size={24} />}
        label="Profile"
        active={tab === 'profile'}
        onClick={() => onTab('profile')}
      />
      {/* Plugin pages ride the rail as their own items on the desktop, which
          has the vertical room; the phone bar folds them into its Plugins
          button (cascading up out of the bar) instead. Books is not among them
          - it lives in the Library's toggle. */}
      {pages
        .filter((pg) => pg.pluginId !== 'books')
        .map((pg) => (
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
    // No foot on the rail. Settings sits in the window's own title bar on
    // desktop (App.tsx, in the same DESKTOP block that renders this rail), and
    // a rail cog beside it was the same door twice - the sort of duplicate that
    // makes people wonder whether the two lead somewhere different. Downloads
    // has no seat here either: while anything is in flight the chip above the
    // strip is its door, and an idle queue offers no door at all.
    return (
      <NavBar
        /* Horizontal, because it lies along the bottom now rather than running
           up the side. The kit lays a vertical bar out as a column and would
           fight the CSS that turns it. */
        orientation="horizontal"
        aria-label="Primary"
        className="appNavRail"
      >
        {primaryItems}
      </NavBar>
    );
  }

  // The phone bar: a floating island of even tabs. It had a raised brand disc
  // in the middle for the library, which made the library look like a different
  // KIND of thing from Search and Friends when it is simply another
  // destination - and cost the plate a band of height to overhang into. It is
  // an ordinary tab now, lit like any other.
  //
  // LIBRARY LEADS, as it does on the desktop rail above. When the disc stopped
  // being a disc it stayed where the disc had been, in the middle, which is a
  // position it only ever held because it was a different shape - so the app's
  // home sat third behind two places you go less often. The two bars agree on
  // the order now.
  //
  // Plugin pages do NOT take their own bar seats: they gather behind the one
  // Plugins button in the right group (PluginsBarButton), which cascades them
  // up out of the bar - so the core tabs stay put however many plugins are on.
  return (
    <nav className="appNavBar" aria-label="Primary" ref={barRef}>
      {/* The lit plate. One element for the whole bar, parked over the current
          tab and slid when it changes - decoration only, so it is hidden from
          assistive tech, which reads aria-current on the tab itself. */}
      <span className="appNavBarPill" aria-hidden="true" />
      {/* As many as there is room for, in priority order, and the rest fold
          into the ⋮ beside them. The bar used to hold a hand-kept four
          regardless of width, which meant a wide phone left room going spare
          while a narrow one crowded the same four together. */}
      {inBar.map((d) => (
        <BarTab
          key={d.key}
          /* Registered at the menu's size; the bar draws at 22. */
          icon={atSize(d.icon, 22)}
          label={d.label}
          active={d.active}
          onClick={d.go}
        />
      ))}
      {/* The overflow, plus the two that never leave it: the download queue and
          Settings. It is always here, which is why the split above only ever
          plays for the seats beside it. */}
      <NavMoreMenu overflow={inMenu} tab={tab} onTab={onTab} onSettings={onSettings} onOpenDownloads={onOpenDownloads} />
    </nav>
  );
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
