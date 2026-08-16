import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Download, EllipsisVertical, Settings, UsersRound } from '@glacier/icons';
import { useHasDownloadQueue, usePluginPages } from '../plugins/runtime.tsx';
import { useDownloadsOptional } from '../plugins/importsBridge.ts';

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
  const dl = useDownloadsOptional();
  const dlActive = dl?.active.length ?? 0;
  // The page is worth offering the moment ANYTHING can download - the music
  // importer through its bridge, or any plugin that contributes a queue. Read
  // off the declarations rather than the live queues: asking every source what
  // it is carrying means calling its hook, and a menu must not mount a plugin
  // hook scope just to decide whether to draw a row. The consequence is that
  // the count beside the label is the importer's alone; books in flight open
  // the page, they just do not number it.
  const hasQueue = useHasDownloadQueue();
  const [open, setOpen] = useState(false);

  // The ⋮ lights when what is on screen lives in this menu.
  // Stats and Date are Profile's rooms now, so the drawer no longer claims
  // them; the DJ moved into the Booth's nav seat.
  const onMenuDest =
    pages.some((pg) => pg.key === tab) || tab === 'friends' || tab === 'downloads';

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
        onClick={() => setOpen((v) => !v)}
      >
        <span className="appNavBarTab__icon">
          <EllipsisVertical size={24} />
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
            <div className="appNavMore__scrim" aria-hidden onPointerDown={() => setOpen(false)} />
            <div className="appNavMore__menu" role="menu" aria-label="More">
        {pages.map((pg) => (
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

        {pages.length > 0 && <span className="appNavBarPlugins__divider" aria-hidden />}

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

        {hasQueue && (
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
            <span className="appNavBarPlugins__itemLabel">
              Downloads{dlActive > 0 ? ` (${dlActive})` : ''}
            </span>
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
