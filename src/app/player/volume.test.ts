import { describe, expect, it } from 'vitest';
import { snapToUnity, VOLUME_MAX, VOLUME_UNITY } from './volume.ts';

/**
 * The fader's detent.
 *
 * A magnetic notch at unity: 100% takes a deliberate extra drag to pass
 * rather than being easy to skim over. Six units of radius, which is a real
 * number rather than a feeling - it decides how far a thumb has to travel
 * before the boost region starts, and it is read by the haptic edge detector
 * as well as by the value, so widening it silently changes when the phone
 * buzzes too.
 */

describe('snapToUnity', () => {
  it('clamps to unity inside the band, from both sides', () => {
    expect(snapToUnity(96)).toBe(VOLUME_UNITY);
    expect(snapToUnity(104)).toBe(VOLUME_UNITY);
    expect(snapToUnity(100)).toBe(VOLUME_UNITY);
  });

  it('holds at exactly six units out, and lets go at seven', () => {
    // The boundary from both sides, which is the whole of the rule: `<=` not
    // `<`, so 94 and 106 are still caught.
    expect(snapToUnity(94)).toBe(VOLUME_UNITY);
    expect(snapToUnity(106)).toBe(VOLUME_UNITY);
    expect(snapToUnity(93)).toBe(93);
    expect(snapToUnity(107)).toBe(107);
  });

  it('leaves the rest of the fader alone', () => {
    expect(snapToUnity(0)).toBe(0);
    expect(snapToUnity(50)).toBe(50);
    expect(snapToUnity(VOLUME_MAX)).toBe(VOLUME_MAX);
  });

  it('never invents a value outside the fader’s own travel', () => {
    for (let v = 0; v <= VOLUME_MAX; v += 1) {
      const out = snapToUnity(v);
      expect(out).toBeGreaterThanOrEqual(0);
      expect(out).toBeLessThanOrEqual(VOLUME_MAX);
    }
  });

  it('keeps unity below the ceiling, so the boost region exists at all', () => {
    expect(VOLUME_UNITY).toBe(100);
    expect(VOLUME_MAX).toBe(150);
    expect(VOLUME_MAX).toBeGreaterThan(VOLUME_UNITY);
  });
});
