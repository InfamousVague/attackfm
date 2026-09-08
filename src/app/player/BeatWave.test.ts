import { describe, expect, it } from 'vitest';
import { sampleWave, WAVE_MID_Y, WAVE_SHADOW_DROP } from './BeatWave.tsx';

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
