import { useSyncExternalStore } from 'react';

/**
 * How the four library doors are dressed.
 *
 * These four are the ones the app ships - the set Matt settled on out of the
 * thirty-six directions the card lab held. The lab has since been removed: it
 * was a workshop for choosing, and the choosing is done. All four lean on
 * bones the plain card does not have - a count on its own, a grid of the
 * collection's own sleeves, a screen of dots over the art - so unlike the old
 * printed default, the shipped look is NOT "no attribute": every one of
 * these is a real `data-card-style` value with its own stylesheet, and Numbers
 * first is simply the one applied when nothing has been chosen.
 *
 * Applied as `data-card-style` on the document element, the way the theme is,
 * so the whole set is CSS. Nothing re-renders when it changes; the cards are
 * already on screen and simply put on different clothes.
 */
export type CardStyle = 'stat' | 'mosaic' | 'chrome' | 'halftoneRich';

/**
 * The table carries KEYS, not prose.
 *
 * This module is imported for its side effect - `apply()` runs from the body,
 * before React exists - so anything spelled out here is resolved long before a
 * language has been chosen, and the picker would go on describing the styles
 * in whatever language the app booted in. The two places that show these read
 * them through `t()` at render instead, which is the only point at which the
 * answer can change with the picker.
 */
export const CARD_STYLES: { id: CardStyle; nameKey: string; noteKey: string }[] = [
  { id: 'stat', nameKey: 'settings.cardStyleStat', noteKey: 'settings.cardStyleStatNote' },
  { id: 'mosaic', nameKey: 'settings.cardStyleMosaic', noteKey: 'settings.cardStyleMosaicNote' },
  { id: 'chrome', nameKey: 'settings.cardStyleChrome', noteKey: 'settings.cardStyleChromeNote' },
  { id: 'halftoneRich', nameKey: 'settings.cardStyleRich', noteKey: 'settings.cardStyleRichNote' },
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
