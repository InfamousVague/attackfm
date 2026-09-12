import { describe, expect, it } from 'vitest';
import { BOX_QUIET_MS, isBoxQuiet } from './boxQuiet.ts';

/**
 * When a delegating hub's download box counts as quiet.
 *
 * A hub in collector mode hands every download to another box; when that box
 * slept or died with a song in hand, the song's row spun on every device for
 * a day. The threshold matches the hub's own (collector.rs BOX_QUIET_MS), which
 * is also when the hub starts letting a cancel through.
 */
describe('isBoxQuiet', () => {
  const NOW = 1_800_000_000_000;

  it('is never true on a hub that downloads for itself', () => {
    expect(isBoxQuiet(false, null, NOW)).toBe(false);
    expect(isBoxQuiet(false, NOW - 10 * BOX_QUIET_MS, NOW)).toBe(false);
  });

  it('is false while the box keeps calling in', () => {
    expect(isBoxQuiet(true, NOW - 60_000, NOW)).toBe(false);
  });

  it('is true once the box has been silent for the hub’s threshold', () => {
    expect(isBoxQuiet(true, NOW - BOX_QUIET_MS, NOW)).toBe(true);
  });

  it('is true when no box has ever called in', () => {
    expect(isBoxQuiet(true, null, NOW)).toBe(true);
  });

  it('matches the hub: twenty minutes', () => {
    expect(BOX_QUIET_MS).toBe(20 * 60 * 1000);
  });
});
