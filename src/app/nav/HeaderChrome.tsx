import { Button } from '@glacier/react';
import { ChevronLeft, Compass, Play, Shuffle } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { useHeaderActions, type HeaderActions } from './headerActions.ts';
import wordmark from '../../assets/attack-white.png';

export const APP_NAME = 'AttackFM';

/**
 * Who you are looking at, in the header: the tab's own name, the wordmark on a
 * tab that has none - or, when the page below has scrolled far enough to lend
 * the header its identity, that page's name instead.
 *
 * The two live in one grid cell and cross-fade between them. Stacked rather
 * than swapped so neither the back arrows on one side nor Play on the other
 * moves while the words change: the cell is already as wide as the wider of
 * the two, so the fade is the only thing that happens.
 *
 * `shown` outlives the lend on purpose. Reading the title straight from the
 * store would blank the outgoing layer's text the instant the page withdrew,
 * and a fade-out with nothing left to fade is just a disappearance.
 */
export function HeaderIdent({ tab }: { tab: string }) {
  const lent = useHeaderActions();
  const lentTitle = lent?.title ?? null;
  const [shown, setShown] = useState<string | null>(lentTitle);
  const [shownArt, setShownArt] = useState<string | null>(lent?.art ?? null);
  const [shownRound, setShownRound] = useState(lent?.artRound ?? false);
  useEffect(() => {
    if (!lentTitle) return;
    setShown(lentTitle);
    setShownArt(lent?.art ?? null);
    setShownRound(lent?.artRound ?? false);
  }, [lentTitle, lent?.art, lent?.artRound]);

  return (
    <span className="mobileHeader__ident">
      <span className="mobileHeader__identLayer" data-on={!lentTitle || undefined} aria-hidden={!!lentTitle}>
        {tab === 'library' ? (
          <span className="mobileHeader__title">Library</span>
        ) : tab === 'downloads' ? (
          <span className="mobileHeader__title">Downloads</span>
        ) : tab === 'friends' ? (
          <span className="mobileHeader__title">Friends</span>
        ) : tab === 'profile' ? (
          <span className="mobileHeader__title">Profile</span>
        ) : tab === 'booth' ? (
          <span className="mobileHeader__title">The Booth</span>
        ) : tab === 'discover' ? (
          /* Named like every other tab rather than wearing the wordmark. The
             compass comes with it because Discover is the one destination whose
             name does not say what it holds - Library and Downloads do. */
          <span className="mobileHeader__title mobileHeader__title--glyphed">
            <Compass size={17} aria-hidden />
            Discover
          </span>
        ) : (
          <img className="mobileHeader__logo" src={wordmark} alt={APP_NAME} />
        )}
      </span>
      <span className="mobileHeader__identLayer" data-on={lentTitle || undefined} aria-hidden={!lentTitle}>
        {/* The picture rides with the name, from the same lend. Kept in state
            alongside it so it survives the withdrawal and fades out rather
            than blinking away a frame early. */}
        {shownArt && (
          <img
            className="mobileHeader__thumb"
            data-round={shownRound || undefined}
            src={shownArt}
            alt=""
            aria-hidden
          />
        )}
        <span className="mobileHeader__title">{shown}</span>
      </span>
    </span>
  );
}

/**
 * Whatever the page below has asked the header to offer - Play and Shuffle over
 * a song collection, today. Draws nothing when nobody is asking, so the header
 * is unchanged on every other page.
 */
export function HeaderActionButtons() {
  const actions = useHeaderActions();
  // The last page to lend its controls, kept after it withdraws.
  //
  // Rendering straight off the store meant these mounted and unmounted, and an
  // element that is gone cannot fade: the title beside them cross-faded while
  // the buttons snapped in and out, which read as two different things
  // happening rather than one. Holding the last set lets them animate out on
  // their own terms - the handlers are dead by then anyway, since `on` is what
  // gates the pointer.
  const [shown, setShown] = useState<HeaderActions | null>(actions);
  useEffect(() => {
    if (actions) setShown(actions);
  }, [actions]);

  const on = actions !== null;
  if (!shown) return null;

  return (
    <span className="mobileHeader__lent" data-on={on || undefined} aria-hidden={!on}>
      <Button
        variant="solid"
        size="sm"
        onClick={shown.play}
        disabled={shown.disabled}
        tabIndex={on ? 0 : -1}
      >
        <Play size={14} fill="currentColor" />
        Play
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={shown.shuffle}
        disabled={shown.disabled}
        aria-label="Shuffle"
        tabIndex={on ? 0 : -1}
      >
        <Shuffle size={14} />
      </Button>
    </span>
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
export function TopScrim({ resetKey }: { resetKey: string }) {
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

/** The slim bar over a Profile room: where you are, and the way back. */
export function RoomBar({ label, onBack }: { label: string; onBack: () => void }) {
  return (
    <div className="profileRoomBar">
      <button type="button" className="profileRoomBar__back" onClick={onBack}>
        <ChevronLeft size={18} />
        <span>Profile</span>
      </button>
      <span className="profileRoomBar__label">{label}</span>
      <span className="profileRoomBar__spacer" aria-hidden="true" />
    </div>
  );
}
