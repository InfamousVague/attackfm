import { useNavPill } from './useNavPill.ts';
import { ArrowDownToLine, Disc3, LibraryBig, Search, Settings, Telescope } from '@glacier/icons';
import { useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { atSize, useNavSeats, type NavDest } from './navSeats.ts';
import { useAcquire, usePluginPages } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { NavMoreMenu } from './NavMoreMenu.tsx';
import { openSearchPage } from '../search/SearchEntry.tsx';
import { useDeveloperMode } from '../settings/developerMode.ts';
import { NavProfileIcon } from './NavProfileIcon.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

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
  const t = useT();
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
  // next - see useNavPill. Bar only: the rail marks its active row with a
  // border and a wash rather than a travelling plate, because a column's rows
  // are far enough apart that a plate sliding between them reads as a lift
  // rather than a move.
  useNavPill(barRef);
  const dests = useMemo<NavDest[]>(() => {
    const list: NavDest[] = [
      // Discover FIRST, by request: what the machine has for you leads the bar.
      {
        key: 'discover',
        label: t('nav.discover'),
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
        label: t('nav.search'),
        icon: <Search size={24} />,
        active: false,
        go: () => openSearchPage(),
      },
      // Then the Library - what you kept and made. Books used to hold a seat
      // of their own here; they are a Music/Books toggle at the top of the
      // Library now, so the shelf and the songs share one destination.
      {
        key: 'library',
        label: t('nav.library'),
        icon: <LibraryBig size={24} />,
        active: libraryActive,
        go: () => onTab('library'),
      },
    ];
    // Profile carries the people now - Friends folded back in under you, so
    // the two "people" seats became one.
    list.push({
      key: 'profile',
      label: t('nav.profile'),
      icon: <NavProfileIcon />,
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
        label: t('nav.booth'),
        icon: <Disc3 size={24} />,
        active: tab === 'booth',
        go: () => onTab('booth'),
      });
    }
    return list;
    // `t` is in here on purpose: react-i18next hands back a NEW t when the
    // language changes, and without it the memo would hold the old labels -
    // a nav bar still in English under an app that is not.
  }, [pages, libraryActive, tab, onTab, showBooth, t]);

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


  if (variant === 'rail') {
    /*
     * The desktop rail: a full-height column of named destinations.
     *
     * It was a slim icon plate lying along the bottom, and before that a
     * floating pill halfway up the leading edge. The pill was moved because it
     * sat "in the one place nothing else on the screen lives"; the plate that
     * replaced it answered that but kept the rail a strip of unlabelled icons
     * with no room to grow, so every new destination made the icons harder to
     * tell apart. A column that owns the whole side answers both: it is not
     * stranded mid-edge, and it has room for the word next to the glyph.
     *
     * Hand-rolled rather than the kit's <NavBar orientation="vertical">, and
     * that is forced: the kit drops labels entirely when vertical (showLabels
     * "renders it beside HORIZONTAL icons" - the vertical item is a fixed
     * square with no label span at all). An icon-only rail is what the kit
     * offers and is not what this is.
     *
     * Built from `dests` - the SAME list the phone bar renders. Two hand-kept
     * lists had already drifted: the bar lit Profile for the friends route and
     * the rail did not. That one is latent (goTab redirects friends to
     * profile) but it is exactly the kind of divergence a second list
     * guarantees eventually, and there is no reason for the desktop to know a
     * different set of places than the phone.
     */
    return (
      <nav className="appNavRail" aria-label={t('nav.primary')} ref={barRef}>
        <div className="appNavRail__dests">
          {dests.map((d) => (
            <button
              key={d.key}
              type="button"
              className="appNavRail__item"
              data-active={d.active || undefined}
              aria-current={d.active ? 'page' : undefined}
              onClick={d.go}
            >
              <span className="appNavRail__icon" aria-hidden>
                {d.icon}
              </span>
              <span className="appNavRail__label">{d.label}</span>
            </button>
          ))}
        </div>
        {/*
          The foot: the two doors the phone keeps in its overflow.

          They were left off the rail on purpose when it was a strip - Settings
          because the window's title bar already has a cog, Downloads because
          the chip above the player strip is its door while anything is in
          flight. A full-height column changes the argument for both: there is
          room, the phone shows them, and "the same routes as mobile" is the
          whole point of this shape. The title-bar cog stays; two doors to
          Settings on a desktop is ordinary, and a rail without one reads as
          incomplete next to a phone that has it.
        */}
        <div className="appNavRail__foot">
          <button type="button" className="appNavRail__item" onClick={onOpenDownloads}>
            <span className="appNavRail__icon" aria-hidden>
              <ArrowDownToLine size={22} />
            </span>
            <span className="appNavRail__label">{t('nav.downloads')}</span>
          </button>
          <button type="button" className="appNavRail__item" onClick={onSettings}>
            <span className="appNavRail__icon" aria-hidden>
              <Settings size={22} />
            </span>
            <span className="appNavRail__label">{t('nav.settings')}</span>
          </button>
        </div>
      </nav>
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
    <nav className="appNavBar" aria-label={t('nav.primary')} ref={barRef}>
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
          /* Registered at the menu's size; the bar draws at 26 - and this
             number has to match the stylesheet's, which sizes the svg box.
             When they disagreed the glyph was drawn at one size and stretched
             to the other, so the stroke came out at the wrong weight for the
             box it was in. */
          icon={atSize(d.icon, 26)}
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
