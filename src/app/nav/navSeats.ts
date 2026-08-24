import { cloneElement, isValidElement, useLayoutEffect, useState } from 'react';
import type { ReactElement, ReactNode, RefObject } from 'react';

/**
 * One place the nav can send you, wherever it happens to be drawn.
 *
 * The same record is rendered as a bar tab when there is room for it and as a
 * menu row when there is not, which is what lets a destination move between the
 * two without either side knowing the other's business.
 */
export interface NavDest {
  key: string;
  label: string;
  /** Drawn at the MENU's size (18). The bar re-cuts it - see `atSize`. */
  icon: ReactNode;
  active: boolean;
  go: () => void;
}

/**
 * The same glyph at another size.
 *
 * Plugin pages register their icon once, at the size the menu draws (18), and
 * the bar draws every tab at 22. Seating the registered element as-is put a
 * visibly smaller glyph in the bar next to the core tabs - which is what the
 * Books seat had to work around by hand before any of this moved.
 */
export function atSize(icon: ReactNode, size: number): ReactNode {
  return isValidElement(icon)
    ? cloneElement(icon as ReactElement<{ size?: number }>, { size })
    : icon;
}

/**
 * How many tab-sized seats the bar has room for.
 *
 * Every seat is the same width - the tabs and the ⋮ alike wear `.appNavBarTab`,
 * which is deliberately square and `flex: none` - so this is arithmetic rather
 * than per-item measurement: room, divided by a seat plus the gap after it.
 *
 * MEASURED, never assumed from the rem. The seat is 3.4rem and the gap a token,
 * but both ride `--glacier-density-scale` and the interface-size setting, so a
 * hard-coded 54px would be wrong for anybody who has touched either. Reading
 * the real box also means this cannot drift when the CSS changes.
 *
 * The observer watches the bar AND a seat: the bar catches a window resize or a
 * rotation, and the seat catches an interface-size change, which alters what
 * fits WITHOUT altering the bar's own width - so watching only the bar would
 * leave the nav a size behind until something else moved.
 *
 * It re-subscribes on its OWN answer, and on `count`. When either changes the
 * split changes, the first seat is a different element, and an observer still
 * holding the old one would stop hearing about it. This cannot loop: the bar is
 * positioned by its inset rather than by its contents, so taking a tab out does
 * not change the room available - the second pass measures the same number and
 * React stops there.
 */
export function useNavSeats(bar: RefObject<HTMLElement | null>, count: number): number | null {
  const [seats, setSeats] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = bar.current;
    if (!el) return;

    const measure = () => {
      const seat = el.querySelector<HTMLElement>('.appNavBarTab');
      if (!seat) return;
      const width = seat.getBoundingClientRect().width;
      const room = el.clientWidth;
      if (!(width > 0) || !(room > 0)) return;
      const cs = getComputedStyle(el);
      /*
       * THIS DEPENDS ON THE BAR SPANNING ITS INSETS, which means it depends on
       * being inside `.appWindow` - the wrapper that declares `--app-nav-inset`.
       * Both are, today (App.tsx). Drawn anywhere else the inset resolves to
       * nothing, an absolutely positioned box with no inset shrink-wraps its
       * children, and this would be measuring how much room the tabs NEED
       * instead of how much room there is - collapsing the bar one tab at a
       * time until a single tab was left.
       *
       * There is deliberately no runtime guard for it. The obvious one - asking
       * whether the computed inset is `auto` - cannot work: for a positioned
       * box `getComputedStyle` reports the USED value, so `auto` reads back as a
       * pixel number and the check silently passes. A guard that cannot fire is
       * worse than none, because it reads like protection.
       */
      const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      const gap = parseFloat(cs.columnGap) || 0;
      // The last seat has no gap after it, so a gap is lent to the division and
      // taken back by it: n seats cost n*(seat+gap) - gap.
      const fits = Math.floor((room - pad + gap) / (width + gap));
      // One seat always, however cruel the width: a nav with nothing in it is
      // worse than a nav that has had to give everything to the menu.
      setSeats(Math.max(1, fits));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const seat = el.querySelector<HTMLElement>('.appNavBarTab');
    if (seat) ro.observe(seat);
    return () => ro.disconnect();
  }, [bar, count, seats]);

  return seats;
}
