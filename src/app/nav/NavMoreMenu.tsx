import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CounterBadge } from '@glacier/react';
import { Disc3, Download, EllipsisVertical, Settings, UsersRound } from '@glacier/icons';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { usePluginPages } from '../../plugins/runtime.tsx';

/**
 * The bar's overflow: a vertical-ellipsis tab that opens the app's "rest of the
 * options" - every enabled plugin's page (the Books shelf among them), then the
 * secondary destinations that no longer earn a permanent seat: Stats, the
 * download queue while one is running, and Settings.
 *
 * Built on the kit's Popover so the panel is a real one: it PORTALS to the body,
 * which is what gives it the glass and the blur (a hand-rolled panel nested
 * inside the bar's own backdrop-filter cannot blur - the filter traps it), and
 * brings outside-press/Escape dismissal for free. Controlled only so a chosen
 * row can close it on the way out.
 */
export function NavMoreMenu({
  tab,
  onTab,
  onSettings,
}: {
  tab: string;
  onTab: (tab: string) => void;
  onSettings: () => void;
}) {
  const pages = usePluginPages();
  // Books sits on the bar itself now; listing it here too would be the same
  // door twice in one hand.
  const menuPages = pages.filter((pg) => pg.key.split(':')[0] !== 'books');
  const [open, setOpen] = useState(false);
  // The queue's presence, for the Downloads row and the count riding the ⋮.
  const dl = useDownloadsOptional();
  const pulling = dl?.active.length ?? 0;
  const failed = dl?.jobs.filter((j) => j.state === 'error').length ?? 0;
  /*
   * When the scrim last closed the menu.
   *
   * The scrim is fixed over the whole window at z-40; the nav bar it covers
   * sits at z-4 and cannot be raised out of it, because a child never escapes
   * its parent's stacking context. So a second press on ⋮ lands on the SCRIM,
   * which closes on pointerdown - and then the click that follows, the scrim
   * having unmounted under the finger, is dispatched to the ⋮ beneath and
   * toggles the menu straight back open. The menu blinked and stayed.
   *
   * The stamp lets the trigger recognise that click as the tail of the press
   * that just closed it, rather than a new intent to open.
   */
  const closedByScrim = useRef(0);

  // The ⋮ lights when what is on screen lives in this menu.
  // Stats and Date are Profile's rooms now, so the drawer no longer claims
  // them; the DJ moved into the Booth's nav seat.
  const onMenuDest =
    menuPages.some((pg) => pg.key === tab) ||
    tab === 'friends' ||
    tab === 'downloads' ||
    tab === 'booth';

  const go = (next: string) => {
    setOpen(false);
    onTab(next);
  };

  // Closed on Escape like any menu. Bound only while open, so the app is not
  // carrying a key listener for a menu nobody opened.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="appNavMore__anchor">
      <button
        type="button"
        className="appNavBarTab appNavBarPlugins__trigger"
        data-active={onMenuDest || open || undefined}
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          // Longer than the gap between a press and its click, far shorter
          // than anyone deliberately reopening a menu they just dismissed.
          if (Date.now() - closedByScrim.current < 400) return;
          setOpen((v) => !v);
        }}
      >
        <span className="appNavBarTab__icon">
          <EllipsisVertical size={22} />
          <CounterBadge
            className="appNavBadge--corner"
            count={pulling > 0 ? pulling : failed}
            max={99}
            size="sm"
            tone={pulling === 0 ? 'danger' : 'accent'}
            aria-label={pulling > 0 ? `${pulling} downloading` : `${failed} failed`}
          />
        </span>
        <span className="appNavBarTab__label">More</span>
      </button>
      {/* PORTALLED to the body, and that is load-bearing rather than tidiness:
          backdrop-filter cannot reach past an ancestor that already has one,
          and the nav bar is frosted glass. A menu rendered inside the bar is
          trapped in the bar's own backdrop and comes out flat - which is the
          bug the kit's Popover was originally adopted to avoid, and which
          rendering our own markup in place quietly reintroduced. Out here it
          blurs the page like the bar does; the fixed insets below put it back
          exactly where the ⋮ is. */}
      {open &&
        createPortal(
          <>
            {/* A tap anywhere else closes, which is the gesture people reach
                for before they look for a button. */}
            <div
              className="appNavMore__scrim"
              aria-hidden
              onPointerDown={() => {
                closedByScrim.current = Date.now();
                setOpen(false);
              }}
            />
            <div className="appNavMore__menu" role="menu" aria-label="More">
        {menuPages.map((pg) => (
          <button
            key={pg.key}
            type="button"
            role="menuitem"
            className="appNavBarPlugins__item"
            data-active={tab === pg.key || undefined}
            onClick={() => go(pg.key)}
          >
            <span className="appNavBarPlugins__itemIcon" aria-hidden>
              {pg.icon}
            </span>
            <span className="appNavBarPlugins__itemLabel">{pg.label}</span>
          </button>
        ))}

        {menuPages.length > 0 && <span className="appNavBarPlugins__divider" aria-hidden />}

        {/* Date and Stats live inside Profile as rooms now, and the DJ holds
            a real nav seat as the Booth - the drawer keeps only what has no
            better home: Friends, the download queue while it runs, Settings. */}

        {/* The people, reachable without going through Profile first. The
            profile page keeps its own door onto this - the one with their
            faces on it and the count of who is waiting on you - because that
            door says something a menu row cannot. This is the shortcut for
            when you already know where you are going.

            Ungated, like Date and DJ: friends live on the registry account
            rather than a server, and the page draws its own signed-out face
            (AccountSetup) rather than needing the menu to hide it. */}
        {/* The Booth: the DJ's room. It held a bar seat until the Books shelf
            needed one more; a place you visit accepts a menu row, a place you
            live in does not. */}
        <button
          type="button"
          role="menuitem"
          className="appNavBarPlugins__item"
          data-active={tab === 'booth' || undefined}
          onClick={() => go('booth')}
        >
          <span className="appNavBarPlugins__itemIcon" aria-hidden>
            <Disc3 size={18} />
          </span>
          <span className="appNavBarPlugins__itemLabel">Booth</span>
        </button>

        <button
          type="button"
          role="menuitem"
          className="appNavBarPlugins__item"
          data-active={tab === 'friends' || undefined}
          onClick={() => go('friends')}
        >
          <span className="appNavBarPlugins__itemIcon" aria-hidden>
            <UsersRound size={18} />
          </span>
          <span className="appNavBarPlugins__itemLabel">Friends</span>
        </button>

        {/* The queue, whenever an importer exists at all - not only mid-pull:
            the page holds history and retries, and a door that only exists
            while work is running cannot be found when the work has failed.
            The count rides as a badge: blue-lit while pulling, the failure
            count in the warning tone when that is all that is left. */}
        {dl && (
          <button
            type="button"
            role="menuitem"
            className="appNavBarPlugins__item"
            data-active={tab === 'downloads' || undefined}
            onClick={() => go('downloads')}
          >
            <span className="appNavBarPlugins__itemIcon" aria-hidden>
              <Download size={18} />
            </span>
            <span className="appNavBarPlugins__itemLabel">Downloads</span>
            <CounterBadge
              className="appNavBadge--row"
              count={pulling > 0 ? pulling : failed}
              max={99}
              size="sm"
              tone={pulling === 0 ? 'danger' : 'accent'}
              aria-label={pulling > 0 ? `${pulling} downloading` : `${failed} failed`}
            />
          </button>
        )}

        <button
          type="button"
          role="menuitem"
          className="appNavBarPlugins__item"
          onClick={() => {
            setOpen(false);
            onSettings();
          }}
        >
          <span className="appNavBarPlugins__itemIcon" aria-hidden>
            <Settings size={18} />
          </span>
          <span className="appNavBarPlugins__itemLabel">Settings</span>
        </button>
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
