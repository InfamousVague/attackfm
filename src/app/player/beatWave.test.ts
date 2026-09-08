import { describe, expect, it } from 'vitest';
import { baseOffset, clamp01, sampleWave, WAVE_MID_Y, WAVE_SHADOW_DROP } from './beatWave.ts';

/**
 * The mark's silhouette.
 *
 * `sampleWave` exists so the dock icon's frame renderer and the in-app mark
 * draw the SAME wave at every energy level - two renderers, one shape. That
 * is the whole contract, and it is one nobody can eyeball: the icon is
 * generated into a file and the mark is drawn in the app, and a drift between
 * them shows up as "the dock icon looks a bit off" months later.
 *
 * So the assertions here are the geometry the two renderers agree on: the
 * viewBox span, the sample count, and that swell scales the offset linearly
 * about the midline rather than moving the wave up or down the box.
 */

describe('sampleWave', () => {
  it('spans the viewBox from 8 to 92, inclusive at both ends', () => {
    const points = sampleWave(1);
    expect(points[0]![0]).toBe(8);
    expect(points.at(-1)![0]).toBe(92);
  });

  it('returns one more point than samples - the fenceposts', () => {
    // 72 segments need 73 points. An off-by-one here draws a wave that stops
    // just short of the right-hand edge in one renderer and not the other.
    expect(sampleWave(1)).toHaveLength(73);
    expect(sampleWave(1, 8)).toHaveLength(9);
  });

  it('spaces x evenly, whatever the sample count', () => {
    const points = sampleWave(1, 4);
    expect(points.map((p) => p[0])).toEqual([8, 29, 50, 71, 92]);
  });

  it('scales the offset linearly with swell, keeping x fixed', () => {
    const one = sampleWave(1, 8);
    const two = sampleWave(2, 8);
    one.forEach((p, i) => {
      expect(two[i]![0]).toBe(p[0]);
      expect(two[i]![1]).toBeCloseTo(p[1] * 2, 10);
    });
  });

  it('flattens to the midline at zero swell', () => {
    // dy is an OFFSET from the midline, not an absolute y: at rest the wave
    // is a straight line, and every point reads 0 rather than MID_Y.
    expect(sampleWave(0, 8).every(([, dy]) => dy === 0)).toBe(true);
  });

  it('is a wave, not a line, at full swell', () => {
    // The third case: without it, "flattens at zero" is satisfied by a
    // function that returns zeros forever.
    const dys = sampleWave(1).map(([, dy]) => dy);
    expect(Math.max(...dys)).toBeGreaterThan(0);
    expect(Math.min(...dys)).toBeLessThan(0);
  });

  it('is deterministic - two reads of the same swell agree exactly', () => {
    expect(sampleWave(0.7, 12)).toEqual(sampleWave(0.7, 12));
  });
});

describe('the geometry the two renderers share', () => {
  it('publishes the midline and the shadow drop', () => {
    // Exported precisely so the icon renderer does not carry its own copy of
    // these two numbers - which is how the icon and the mark drift apart.
    expect(WAVE_MID_Y).toBe(54);
    expect(WAVE_SHADOW_DROP).toBe(3);
  });
});

/**
 * The curve underneath, which both renderers reach for directly: the
 * component deforms it per frame with the beat, and `sampleWave` is it at a
 * fixed swell. So a change here moves the mark AND the dock icon at once,
 * which is the point - and the reason the shape's own landmarks are pinned
 * rather than left to whatever the interpolation produces.
 */
describe('baseOffset', () => {
  it('passes exactly through the control points it was traced from', () => {
    // Catmull-Rom interpolates its points rather than approximating them,
    // which is the reason it was chosen: the peak sits where the asset's
    // peak sits. A Bezier would round these off and the mark would lose its
    // depth without anything failing.
    expect(baseOffset(0.625)).toBeCloseTo(-26, 10);
    expect(baseOffset(0.81)).toBeCloseTo(15, 10);
    expect(baseOffset(0.245)).toBeCloseTo(-11.5, 10);
  });

  it('holds the lead-in flat where the points are doubled', () => {
    /*
     * The three points at 0, 0.045 and 0.09 all sit at 0.5, which pins the
     * first stretch level - a Catmull-Rom segment whose four points share a
     * height is a straight line. Only from 0.045 on does the tangent toward
     * the first hump start bending it, which is why the third point is there
     * at all: with a single point at the origin the hump's pull would reach
     * the left-hand edge and the mark would start mid-swing.
     */
    expect(baseOffset(0)).toBeCloseTo(0.5, 10);
    expect(baseOffset(0.02)).toBeCloseTo(0.5, 10);
    expect(baseOffset(0.045)).toBeCloseTo(0.5, 10);
  });

  it('clamps outside the wave rather than extrapolating off the box', () => {
    // A ripple's `at` arrives from the beat and is not guaranteed to be in
    // range; Catmull-Rom asked for u = 2 runs away to a value no viewBox
    // contains, and the path draws as a spike off the top of the icon.
    expect(baseOffset(-1)).toBe(baseOffset(0));
    expect(baseOffset(2)).toBe(baseOffset(1));
  });

  it('reads a NaN as the start of the wave, not as a NaN path', () => {
    // One NaN in a path's `d` attribute voids the whole path - the mark
    // disappears rather than glitching.
    expect(Number.isFinite(baseOffset(Number.NaN))).toBe(true);
    expect(sampleWave(Number.NaN, 4).every(([x]) => Number.isFinite(x))).toBe(true);
  });
});

describe('clamp01', () => {
  it('holds 0..1 and pulls the rest in', () => {
    expect(clamp01(0.5)).toBe(0.5);
    expect(clamp01(-0.2)).toBe(0);
    expect(clamp01(4)).toBe(1);
  });

  it('answers 0 - not 1 - for anything that is not a finite number', () => {
    /*
     * The `Number.isFinite` guard runs BEFORE the range check, so an
     * infinity is treated as a broken reading rather than as a very large
     * one and lands at rest instead of at full deflection. That is the
     * quieter of the two failures: a beat that arrives as Infinity draws the
     * mark still for a frame rather than throwing it at the top of the box.
     */
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clamp01(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});
