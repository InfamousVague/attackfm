import { useSyncExternalStore } from 'react';

/**
 * How the four library doors are dressed.
 *
 * The card lab (seven presses on the wordmark in About) has thirty-six
 * directions in it, which is what a workshop is for: they exist to be compared
 * and argued over, most of them once. These three are the ones the app ships -
 * the set Matt settled on. All three lean on bones the plain card does not have
 * - a count on its own, a grid of the collection's own sleeves - so unlike the
 * old printed default, the shipped look is NOT "no attribute": every one of
 * these is a real `data-card-style` value with its own stylesheet, and Numbers
 * first is simply the one applied when nothing has been chosen.
 *
 * Applied as `data-card-style` on the document element, the way the theme is,
 * so the whole set is CSS. Nothing re-renders when it changes; the cards are
 * already on screen and simply put on different clothes.
 */
export type CardStyle = 'stat' | 'mosaic' | 'chrome';

export const CARD_STYLES: { id: CardStyle; name: string; note: string }[] = [
  {
    id: 'stat',
    name: 'Numbers first',
    note: 'The count is the card, set large, with the object dropped to a watermark behind it. The doors that are really a number - Liked, All songs - lead with it. The look the app ships with.',
  },
  {
    id: 'mosaic',
    name: 'Blurred real art',
    note: 'The collection\'s own sleeves, blurred into a soft field of its real colours rather than laid out sharp. It changes as your library does; a thin library simply shows fewer colours.',
  },
  {
    id: 'chrome',
    name: 'Chrome',
    note: 'Anodised metal that takes each card\'s own colour - rose for Liked, blue steel for All songs - with a slow specular sweep across the plate.',
  },
];

const KEY = 'attackfm-card-style';
const DEFAULT: CardStyle = 'stat';

function isStyle(v: unknown): v is CardStyle {
  return typeof v === 'string' && CARD_STYLES.some((s) => s.id === v);
}

function read(): CardStyle {
  try {
    const raw = localStorage.getItem(KEY);
    return isStyle(raw) ? raw : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

let current: CardStyle = read();
const listeners = new Set<() => void>();

/**
 * Put the choice on the document.
 *
 * The attribute is ALWAYS written, default included. The old default (Duotone)
 * was the plain `.libChip` rules, so writing nothing was how it showed; every
 * shipped style now reskins the card instead, Numbers first among them, so
 * there is no "plain" state to fall back to - a missing attribute would leave
 * the base printed halftone showing, which is no longer an option anyone can
 * pick.
 *
 * Set before React mounts, from the module body, so the cards are never drawn
 * once in the base look and then repainted.
 */
function apply(style: CardStyle): void {
  document.documentElement.setAttribute('data-card-style', style);
}

apply(current);

export function cardStyle(): CardStyle {
  return current;
}

export function setCardStyle(next: CardStyle): void {
  if (next === current) return;
  current = next;
  apply(next);
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // The look changes for this run; it simply will not survive a relaunch.
  }
  for (const fn of listeners) fn();
}

export function useCardStyle(): CardStyle {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    cardStyle,
    cardStyle,
  );
}
