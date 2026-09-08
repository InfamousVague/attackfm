import { describe, expect, it } from 'vitest';
import { EQ_BANDS, EQ_NARROW_INDICES, EQ_PRESETS } from './equalizer.tsx';
import { eqPresets, eqPresetsNarrow, expandNarrowGains, narrowEqGains } from './eqPresets.ts';

/**
 * The eight bands, held five at a time.
 *
 * The graph always runs all eight - the narrow view is a way of HOLDING the
 * sliders on a phone, not a different equalizer - and that makes two
 * projections the whole feature rests on: which five are shown, and where a
 * dragged five goes back to. Both are pure arithmetic over an index table,
 * and both fail silently: a wrong band moves the wrong frequency, and nobody
 * hears which of eight filters got the 6dB. Only a test can say.
 *
 * `t` is passed in everywhere below rather than left to default. Without an
 * i18next catalogue `translate` answers with the key itself, which would
 * still pass every assertion here and prove nothing about whether the
 * translator was consulted at all.
 */

/** A translator that shouts, so a label that skipped it is obvious. */
const shout = (key: string) => key.toUpperCase();

describe('eqPresets', () => {
  it('names every curve through the translator it is handed', () => {
    const named = eqPresets(shout);
    expect(named).toHaveLength(EQ_PRESETS.length);
    expect(named[0]).toMatchObject({ id: 'flat', label: 'PLAYER.EQFLAT' });
    expect(named.every((p) => p.label === p.label.toUpperCase())).toBe(true);
  });

  it('keeps the id, which is what the picker compares on', () => {
    // The label is for reading and changes with the language; the id is the
    // stored value. Naming a preset must never rename it.
    expect(eqPresets(shout).map((p) => p.id)).toEqual(EQ_PRESETS.map((p) => p.id));
  });

  it('hands over the full eight gains, untouched', () => {
    const bassBoost = eqPresets(shout).find((p) => p.id === 'bass-boost');
    expect(bassBoost?.gains).toEqual([6, 5, 4, 2, 0, -2, -3, -4]);
    expect(eqPresets(shout).every((p) => p.gains.length === EQ_BANDS.length)).toBe(true);
  });

  it('leaves nothing carrying a raw catalogue key as its label', () => {
    // A preset added to the table without a `labelKey` would read out as
    // `undefined` in the dropdown rather than failing anywhere.
    expect(eqPresets((k) => `«${k}»`).every((p) => /^«player\..+»$/.test(p.label))).toBe(true);
  });
});

describe('eqPresetsNarrow', () => {
  it('offers the same presets, in the same order, five bands wide', () => {
    const wide = eqPresets(shout);
    const narrow = eqPresetsNarrow(shout);
    expect(narrow.map((p) => p.id)).toEqual(wide.map((p) => p.id));
    expect(narrow.every((p) => p.gains.length === EQ_NARROW_INDICES.length)).toBe(true);
  });

  it('projects each curve onto the shown bands rather than its first five', () => {
    // "bass-boost" is [6,5,4,2,0,-2,-3,-4] across eight. Taking the first
    // five would give [6,5,4,2,0] - a plausible-looking curve that is simply
    // the wrong end of the spectrum.
    const bassBoost = eqPresetsNarrow(shout).find((p) => p.id === 'bass-boost');
    expect(bassBoost?.gains).toEqual([6, 4, 0, -3, -4]);
  });

  it('agrees with narrowEqGains - one projection, not two', () => {
    const narrow = eqPresetsNarrow(shout);
    EQ_PRESETS.forEach((p, i) => {
      expect(narrow[i]!.gains).toEqual(narrowEqGains(p.gains));
    });
  });
});

describe('narrowEqGains', () => {
  it('reads bands 0, 2, 4, 6 and 7 - not the first five', () => {
    // The fixture is the band index itself, so a wrong pick names itself.
    expect(narrowEqGains([0, 1, 2, 3, 4, 5, 6, 7])).toEqual([0, 2, 4, 6, 7]);
  });

  it('keeps the top TWO bands, which are adjacent', () => {
    // 6 and 7 are the one neighbouring pair both shown: the air band has no
    // hidden partner above it. An index table that stepped evenly by two
    // would end at 8 and read a hole.
    expect(EQ_NARROW_INDICES.slice(-2)).toEqual([6, 7]);
    expect(narrowEqGains([0, 0, 0, 0, 0, 0, 9, 9])).toEqual([0, 0, 0, 9, 9]);
  });

  it('reads a hole as flat rather than undefined', () => {
    // A short array reaching the kit's sliders as `undefined` draws nothing.
    expect(narrowEqGains([3])).toEqual([3, 0, 0, 0, 0]);
    expect(narrowEqGains([])).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('expandNarrowGains', () => {
  /** The eight bands as they were before the drag, deliberately NOT a ramp:
   *  the hidden bands sit nowhere near the average of their neighbours, so a
   *  band that gets re-interpolated when it should not have been shows up. */
  const before = [0, 9, 0, 9, 0, 9, 0, 0];

  it('returns all eight bands, whatever it was given', () => {
    // setEqGains SKIPS holes rather than zeroing them, so a short array here
    // leaves the top bands wearing a previous preset's gains forever.
    expect(expandNarrowGains([1, 2, 3, 4, 5], before)).toHaveLength(8);
    expect(expandNarrowGains([], before)).toHaveLength(8);
  });

  it('puts each shown value back on its OWN band', () => {
    const out = expandNarrowGains([1, 2, 3, 4, 5], [0, 0, 0, 0, 0, 0, 0, 0]);
    // Positionally: slider 0 -> band 0, 1 -> 2, 2 -> 4, 3 -> 6, 4 -> 7.
    expect(out[0]).toBe(1);
    expect(out[2]).toBe(2);
    expect(out[4]).toBe(3);
    expect(out[6]).toBe(4);
    expect(out[7]).toBe(5);
  });

  it('round-trips a drag that moved nothing, hidden bands and all', () => {
    // The guard the whole function is built around: nothing moved, so
    // nothing is re-interpolated and the 9s in the hidden bands survive.
    // Without it this comes back [0,0,0,0,0,0,0,0] and a preset's shape is
    // quietly flattened by touching the panel.
    expect(expandNarrowGains(narrowEqGains(before), before)).toEqual(before);
  });

  it('re-interpolates only the hidden bands beside a slider that moved', () => {
    // Drag the sub band (0) up. Band 1 sits between 0 and 2, so it follows;
    // bands 3 and 5 are nowhere near the drag and keep what they had.
    const out = expandNarrowGains([6, 0, 0, 0, 0], [0, 0, 0, 9, 0, 9, 0, 0]);
    expect(out).toEqual([6, 3, 0, 9, 0, 9, 0, 0]);
  });

  it('does not let the treble redraw the bass', () => {
    // The stated rule, as a case: nudging the air band moves nothing below
    // it, because no hidden band has 7 as a neighbour.
    const prev = [4, 4, 4, 4, 0, 0, 0, 0];
    const out = expandNarrowGains([4, 4, 0, 0, 6], prev);
    expect(out.slice(0, 4)).toEqual([4, 4, 4, 4]);
    expect(out[7]).toBe(6);
  });

  it('averages a hidden band between its two shown neighbours', () => {
    // Band 3 sits between 2 and 4; moving either end lands it halfway.
    const out = expandNarrowGains([0, -4, 8, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0]);
    expect(out[3]).toBe(2);
    // And band 1, between 0 and the same moved band 2.
    expect(out[1]).toBe(-2);
  });

  it('reads a missing slider as flat, not as a hole', () => {
    expect(expandNarrowGains([1], [0, 0, 0, 0, 0, 0, 0, 0])).toEqual([1, 0.5, 0, 0, 0, 0, 0, 0]);
  });
});
