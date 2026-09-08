import type { AudioEqualizerPreset } from '@glacier/react';
import { translate } from '../i18n/LocaleShell.tsx';
import {
  BAND_COUNT,
  EQ_NARROW_INDICES,
  EQ_PRESETS,
  EQ_PRESETS_NARROW,
  type EqTranslate,
} from './equalizer.tsx';

/**
 * The presets and the narrow view, as functions.
 *
 * The tables next door are data - the eight bands, the curves, which five a
 * phone shows - and they stay beside the provider that is built from them.
 * What happens TO those tables is here: naming a curve in the language
 * showing now, reading the five sliders out of eight bands, and putting five
 * dragged values back into eight. That last one is the only real algorithm in
 * the equalizer and it was unreachable without rendering a panel.
 */

/**
 * The presets in the kit's own shape, named in the language showing now.
 *
 * Takes the translator rather than reaching for one so a component can hand it
 * `useT()` and re-render on a language change; the `translate` default is for
 * the plugin seam, where a bundle has no hook of the host's to call.
 */
export function eqPresets(t: EqTranslate = translate): AudioEqualizerPreset[] {
  return EQ_PRESETS.map((p) => ({ id: p.id, label: t(p.labelKey), gains: p.gains }));
}

/** The five-band projection, in the kit's shape. Same deal as `eqPresets`. */
export function eqPresetsNarrow(t: EqTranslate = translate): AudioEqualizerPreset[] {
  return EQ_PRESETS_NARROW.map((p) => ({ id: p.id, label: t(p.labelKey), gains: p.gains }));
}

/** The five shown gains, read out of the full eight. */
export function narrowEqGains(full: readonly number[]): number[] {
  return EQ_NARROW_INDICES.map((i) => full[i] ?? 0);
}

/**
 * Five shown gains back into eight real ones, for a MANUAL move: only the
 * hidden bands beside sliders that actually moved are re-interpolated between
 * their shown neighbours - the rest keep whatever a previous preset put
 * there, so nudging the treble does not quietly redraw the bass.
 *
 * This used to snap-match the five values against every preset's projection
 * first, and hand back that preset's full curve on a hit. The idea was
 * "picking a preset while narrow should land the whole shape" - but preset
 * picks never come through here (EqPanel's choose() sets all eight bands
 * directly, and the kit's own preset row is hidden), so the only thing the
 * match ever caught was a hand-drawn curve that COINCIDED with one: dragging
 * 500Hz from 0 to -1 while on "headphones" happens to spell "late-night" in
 * five bands, and the three hidden bands moved to a preset the user never
 * chose. A drag is a drag; it edits what it touched.
 */
export function expandNarrowGains(shown: readonly number[], previous: readonly number[]): number[] {
  const full = Array.from({ length: BAND_COUNT }, (_, i) => previous[i] ?? 0);
  const moved = new Set<number>();
  EQ_NARROW_INDICES.forEach((bandIdx, j) => {
    const next = shown[j] ?? 0;
    if (full[bandIdx] !== next) moved.add(bandIdx);
    full[bandIdx] = next;
  });
  // Each hidden band sits between two shown ones: 1 between 0 and 2, 3
  // between 2 and 4, 5 between 4 and 6.
  for (const [hidden, lo, hi] of [
    [1, 0, 2],
    [3, 2, 4],
    [5, 4, 6],
  ] as const) {
    if (moved.has(lo) || moved.has(hi)) full[hidden] = (full[lo]! + full[hi]!) / 2;
  }
  return full;
}
