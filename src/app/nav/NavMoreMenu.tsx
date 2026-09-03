import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CounterBadge } from '@glacier/react';
import { ChartNoAxesColumn, Download, EllipsisVertical, Settings } from '@glacier/icons';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import type { NavDest } from './navSeats.ts';

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
  overflow,
  tab,
  onTab,
  onSettings,
  onOpenDownloads,
}: {
  /** Whatever did not fit in the bar, in the bar's own order. The menu does
   *  not choose these and no longer keeps a list of its own: one hand decides
   *  what is where, so a destination cannot appear in both or in neither. */
  overflow: NavDest[];
  tab: string;
  onTab: (tab: string) => void;
  onSettings: () => void;
  onOpenDownloads: () => void;
}) {
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
  // The ⋮ lights when what is on screen lives in here - which now depends on
  // the width, since the same destination may be a bar tab on a wider phone.
  const onMenuDest = overflow.some((d) => d.active);

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
        /*
         * TWO different states, and they were one attribute.
         *
         * data-active means "this is the page you are on", and the bar's lit
         * plate is now a single element that slides to whichever tab has it -
         * so it has to be true of exactly one button. Merely having the menu
         * OPEN is not a location, and while it shared this attribute the plate
         * had two candidates and the trigger stole the mark from the tab you
         * were actually on.
         */
        data-active={onMenuDest || undefined}
        data-open={open || undefined}
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
        {/* The destinations the bar had no room for. Same order they would have
            taken up there, so widening the window promotes them from the top of
            this list rather than in some order of its own. */}
        {overflow.map((d) => (
          <button
            key={d.key}
            type="button"
            role="menuitem"
            className="appNavBarPlugins__item"
            data-active={d.active || undefined}
            onClick={() => {
              setOpen(false);
              d.go();
            }}
          >
            <span className="appNavBarPlugins__itemIcon" aria-hidden>
              {d.icon}
            </span>
            <span className="appNavBarPlugins__itemLabel">{d.label}</span>
          </button>
        ))}

        {overflow.length > 0 && <span className="appNavBarPlugins__divider" aria-hidden />}

        {/* Booth and Friends are ordinary destinations now: they take a bar
            seat when there is width for one and fall back here when there is
            not, so they are rendered by the overflow above rather than nailed
            into this menu. What is left below is what never moves: your
            listening, the queue, and Settings. */}

        {/* Stats is a room of Profile's rather than a tab, and a room has no
            seat in the bar - so without a door here the only way back to your
            listening was to remember it was behind Profile. `go` routes it the
            way every other old tab is routed: the stack redirects 'stats' into
            the room. */}
        <button
          type="button"
          role="menuitem"
          className="appNavBarPlugins__item"
          onClick={() => go('stats')}
        >
          <span className="appNavBarPlugins__itemIcon" aria-hidden>
            <ChartNoAxesColumn size={18} />
          </span>
          <span className="appNavBarPlugins__itemLabel">Stats</span>
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
            onClick={() => {
              setOpen(false);
              onOpenDownloads();
            }}
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
