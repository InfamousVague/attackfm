import { Button } from '@glacier/react';
import { ChevronLeft, Play, Shuffle } from '@glacier/icons';
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
  // Held alongside the name for the same reason: the layer fades OUT after the
  // page has withdrawn its lend, and a glyph read straight from the store
  // would vanish a frame early and leave the words fading on their own.
  const [shownGlyph, setShownGlyph] = useState(() => lent?.glyph ?? null);
  useEffect(() => {
    if (!lentTitle) return;
    setShown(lentTitle);
    setShownArt(lent?.art ?? null);
    setShownRound(lent?.artRound ?? false);
    setShownGlyph(() => lent?.glyph ?? null);
  }, [lentTitle, lent?.art, lent?.artRound, lent?.glyph]);

  return (
    <span className="mobileHeader__ident">
      <span className="mobileHeader__identLayer" data-on={!lentTitle || undefined} aria-hidden={!!lentTitle}>
        {tab === 'library' ? (
          <span className="mobileHeader__title">Library</span>
        ) : tab === 'friends' ? (
          <span className="mobileHeader__title">Friends</span>
        ) : tab === 'profile' ? (
          <span className="mobileHeader__title">Profile</span>
        ) : tab === 'booth' ? (
          <span className="mobileHeader__title">The Booth</span>
        ) : (
          <img className="mobileHeader__logo" src={wordmark} alt={APP_NAME} />
        )}
      </span>
      <span className="mobileHeader__identLayer" data-on={lentTitle || undefined} aria-hidden={!lentTitle}>
        {/* The picture rides with the name, from the same lend. Kept in state
            alongside it so it survives the withdrawal and fades out rather
            than blinking away a frame early. */}
        {shownGlyph ? (
          <span className="mobileHeader__glyph" aria-hidden>
            {(() => {
              const Glyph = shownGlyph;
              return <Glyph size={16} />;
            })()}
          </span>
        ) : (
          shownArt && (
            <img
              className="mobileHeader__thumb"
              data-round={shownRound || undefined}
              src={shownArt}
              alt=""
              aria-hidden
            />
          )
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

  // A page's own control, where Play would be. A shelf is a place rather than
  // a collection, so it lends what it actually offers instead of a Play button
  // that would have to choose a book for you.
  const Custom = shown.action?.icon ?? null;

  return (
    <span className="mobileHeader__lent" data-on={on || undefined} aria-hidden={!on}>
      {Custom && shown.action && (
        <Button
          variant="solid"
          size="sm"
          onClick={shown.action.onPress}
          aria-label={shown.action.label}
          title={shown.action.label}
          tabIndex={on ? 0 : -1}
        >
          <Custom size={14} />
          {shown.action.label}
        </Button>
      )}
      {shown.play && (
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
      )}
      {shown.shuffle && (
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
      )}
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
    // The SAME scroll progress the scrim rides is published as a CSS variable,
    // so the collection page's top bar can fade its own black back in off it:
    // the scrim is the shadow UNDER the bar, --app-top-scroll is the bar.
    //
    // It goes on the BAR ELEMENT itself, not on .appWindow. A custom property
    // is inherited, so writing it to an app-wide ancestor on every scroll frame
    // asks the engine to recompute inherited style for the whole subtree at the
    // one moment that cannot afford it - the same shape as the accelerometer
    // parallax pulled out in 0.3.260. The bar is the only reader, so writing to
    // the bar invalidates one element. Found once here (a sibling of the
    // scroller under the same window) and cached - but re-found if it has been
    // DETACHED: .mobileHeader unmounts and remounts when a foldable opens and
    // closes (useDesktopLayout flips DESKTOP), and this effect does not re-run
    // for that - its dep is the page, which did not change. Without the
    // isConnected guard the write would land on a detached node and the bar
    // would silently stop fading until the next navigation. The check is a
    // boolean on a node already held; the re-query pays only the frame after a
    // fold.
    const win = host.closest('.appWindow');
    let bar = win?.querySelector<HTMLElement>('.mobileHeader') ?? null;
    const set = (p: number) => {
      node.style.opacity = String(p);
      if (!bar?.isConnected) bar = win?.querySelector<HTMLElement>('.mobileHeader') ?? null;
      bar?.style.setProperty('--app-top-scroll', String(p));
    };
    // A fresh page mounts parked at the top; start invisible.
    set(0);
    const onScroll = (event: Event) => {
      const target = event.target;
      // Only the page scroller (a direct child of the host) drives the scrim -
      // inner scrollers (track lists, shelves) pass under it untouched.
      if (!(target instanceof HTMLElement) || target.parentElement !== host) return;
      set(Math.min(1, Math.max(0, target.scrollTop) / 56));
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
