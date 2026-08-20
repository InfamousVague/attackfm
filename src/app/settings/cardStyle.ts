import { useSyncExternalStore } from 'react';

/**
 * How the four library doors are dressed.
 *
 * The card lab (seven presses on the wordmark in About) has thirty-six
 * directions in it, which is what a workshop is for: they exist to be compared
 * and argued over, most of them once. These six are the ones the app ships -
 * the set Matt picked out of the lab. Four of them (Numbers first, Real covers,
 * Midnight, Chrome) needed the real cards to grow the bones they lean on - a
 * count on its own, a grid of the collection's own sleeves - which is why they
 * lived in the lab until now; the two that only re-treat the object (Duotone,
 * Risograph) always could have shipped.
 *
 * Applied as `data-card-style` on the document element, the way the theme is,
 * so the whole set is CSS. Nothing re-renders when it changes; the cards are
 * already on screen and simply put on different clothes.
 */
export type CardStyle = 'halftone' | 'stat' | 'mosaic' | 'midnight' | 'riso' | 'chromeDark';

export const CARD_STYLES: { id: CardStyle; name: string; note: string }[] = [
  {
    id: 'halftone',
    name: 'Duotone halftone',
    note: 'One flat printed colour with a dot screen knocked out of it, the object screened through in two inks. The look the app ships with.',
  },
  {
    id: 'stat',
    name: 'Numbers first',
    note: 'The count is the card, set large, with the object dropped to a watermark behind it. The doors that are really a number - Liked, All songs - lead with it.',
  },
  {
    id: 'mosaic',
    name: 'Real covers',
    note: 'The face is made of the sleeves actually in that collection, so it changes as your library does. A thin library shows the gaps - that is the honest state, not a fault.',
  },
  {
    id: 'midnight',
    name: 'Midnight halftone',
    note: 'The same dot screen printed the other way round: hot ink on near-black instead of dark ink on cream. The objects light up instead of sitting flat.',
  },
  {
    id: 'riso',
    name: 'Risograph',
    note: 'Two inks printed slightly out of register on rough paper, the way a risograph misses. The misregistration is the whole look.',
  },
  {
    id: 'chromeDark',
    name: 'Chrome dark',
    note: 'Gunmetal, with one lit edge along the top and a slow specular sweep across the plate. Sits quietly next to the rest of the app.',
  },
];

const KEY = 'attackfm-card-style';
const DEFAULT: CardStyle = 'halftone';

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
 * The default writes NO attribute rather than `data-card-style="halftone"`. The
 * shipped look is what the plain `.libChip` rules already say, so an attribute
 * for it would mean every one of those rules needing a matching selector to
 * stay winning - and the first rule anybody forgot would only break for people
 * who had never opened the setting.
 *
 * Set before React mounts, from the module body, so the cards are never drawn
 * once in the shipped look and then repainted.
 */
function apply(style: CardStyle): void {
  const root = document.documentElement;
  if (style === DEFAULT) root.removeAttribute('data-card-style');
  else root.setAttribute('data-card-style', style);
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
