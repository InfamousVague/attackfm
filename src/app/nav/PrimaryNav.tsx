import { NavBar, NavBarItem } from '@glacier/react';
import { CircleUserRound, Compass, Disc3, LibraryBig } from '@glacier/icons';
import type { ReactNode } from 'react';
import { useAcquire, usePluginPages } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { NavMoreMenu } from './NavMoreMenu.tsx';

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
}: {
  variant: 'rail' | 'bar';
  /** The active tab: 'home', 'library', or a plugin page's `${id}:${page}` key. */
  tab: string;
  onTab: (tab: string) => void;
  onSettings: () => void;
  /** Opens the full-screen search. Never a tab - it is an overlay over
   *  whatever you were doing, and it gives that page back when it closes. */
}) {
  const pages = usePluginPages();
  // Downloads is a plugin surface, not a core one: the tab appears only while an
  // importer is actually running (it provides the downloads bridge). With no
  // importer - a fresh install, or anyone who has not added a plugin source -
  // there is nothing to download, so the tab is absent rather than a dead end.
  const dl = useDownloadsOptional();
  const hasDownloads = dl !== null;
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
      // Built-in pages that own their own route. Without these the deny-list
      // lights Library while you are standing in the Booth - the trap of
      // listing what is NOT library instead of what is. (Stats and Date are
      // Profile's rooms now, not tabs.)
      tab !== 'booth' &&
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
          it is the chip above the player strip, and only while something is
          actually in flight. A queue you visit occasionally does not deserve a
          permanent seat in a bar of four. */}
      {/* No Search station. It was a tab, then a pull-down summons, then an
          icon here - and it is now a bar on Library and Discover themselves,
          which is where people look when they want to look something up. The
          legacy /search route still opens the page, through useNavStack. */}
      <NavBarItem
        icon={<Disc3 size={18} />}
        label="Booth"
        active={tab === 'booth'}
        onClick={() => onTab('booth')}
      />
      {/* Plugin pages ride the rail as their own items on the desktop, which
          has the vertical room; the phone bar folds them into its Plugins
          button (cascading up out of the bar) instead. */}
      <NavBarItem
        icon={<CircleUserRound size={18} />}
        label="Profile"
        active={tab === 'profile'}
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
  // an ordinary tab now, in its place in the row, lit like any other.
  //
  // Plugin pages do NOT take their own bar seats: they gather behind the one
  // Plugins button in the right group (PluginsBarButton), which cascades them
  // up out of the bar - so the core tabs stay put however many plugins are on.
  return (
    <nav className="appNavBar" aria-label="Primary">
      {/* No Search seat here either - see the rail above. The bar it was
          standing in for now lives on Library and Discover themselves, which
          is a bigger target than this tab was and needs no explaining. */}
      <BarTab
        icon={<Disc3 size={22} />}
        label="Booth"
        active={tab === 'booth'}
        onClick={() => onTab('booth')}
      />
      {canDiscover && (
        <BarTab
          icon={<Compass size={22} />}
          label="Discover"
          active={tab === 'discover'}
          onClick={() => onTab('discover')}
        />
      )}
      {/* The library: where the music you own lives, and the app's home. */}
      <BarTab
        icon={<LibraryBig size={22} />}
        label="Library"
        active={libraryActive}
        onClick={() => onTab('library')}
      />
      <BarTab
        icon={<CircleUserRound size={22} />}
        label="Profile"
        active={tab === 'profile'}
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
