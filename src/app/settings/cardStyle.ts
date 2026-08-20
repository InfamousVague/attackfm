import { useSyncExternalStore } from 'react';

/**
 * How the four library doors are dressed.
 *
 * The card lab (seven presses on the wordmark in About) has thirty-six
 * directions in it, which is what a workshop is for: they exist to be compared
 * and argued over, most of them once. These six are the ones the app ships -
 * they work on the real cards' own markup, with no extra elements, so a choice
 * here is a change of stylesheet and nothing else.
 *
 * Applied as `data-card-style` on the document element, the way the theme is,
 * so the whole set is CSS. Nothing re-renders when it changes; the cards are
 * already on screen and simply put on different clothes.
 */
export type CardStyle = 'halftone' | 'editorial' | 'emboss' | 'glass' | 'neon' | 'sticker';

export const CARD_STYLES: { id: CardStyle; name: string; note: string }[] = [
  {
    id: 'halftone',
    name: 'Halftone',
    note: 'One flat printed colour with a dot screen knocked out of it, the object screened through. The look the app ships with.',
  },
  {
    id: 'editorial',
    name: 'Editorial',
    note: 'No picture at all. The name does the work, set large over a hairline rule.',
  },
  {
    id: 'emboss',
    name: 'Emboss',
    note: 'One graphite surface for all four, the object pressed into it rather than laid on top.',
  },
  {
    id: 'glass',
    name: 'Frosted glass',
    note: 'A panel of frost over a saturated field, the object behind it and slightly out of focus.',
  },
  {
    id: 'neon',
    name: 'Neon wire',
    note: 'Near-black card, the object reduced to a glowing outline.',
  },
  {
    id: 'sticker',
    name: 'Die-cut sticker',
    note: 'Flat colour, the object cut out with a keyline and a hard shadow, set a little off square.',
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
