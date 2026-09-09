import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DWELL_MS, keepSeat, seatAfter, useHeroSeat } from './heroSeat.ts';
import type { ActiveFriend } from './friendStanding.ts';
import type { RegistryFriend } from '../servers/registry.ts';

/**
 * The one seat, and who is in it.
 *
 * The failure this file exists to prevent has a specific shape: the hero
 * changes the name under a finger already travelling towards a button, and a
 * groove invite goes to the wrong person. It is not a crash and it is not
 * visible in a screenshot - it needs a clock, so the clock is fake and every
 * rule gets its own test.
 */

function cast(...handles: string[]): ActiveFriend[] {
  return handles.map((handle, i) => ({
    friend: { id: i + 1, handle, serverUrl: '', seenAt: 0, songs: 0, playlists: 0, artists: 0 } as RegistryFriend,
    standing: 'playing' as const,
    rank: 80 - i,
  }));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('keepSeat', () => {
  it('takes the first friend when nobody has held it', () => {
    expect(keepSeat(cast('kim', 'ana'), null, 0)).toBe('kim');
  });

  // Rank decides who gets a turn, never who loses one mid-turn. A friend who
  // pauses while you are reading about them must not yank the card away.
  it('keeps a seated friend who has fallen down the ranking', () => {
    expect(keepSeat(cast('ana', 'ben', 'kim'), 'kim', 0)).toBe('kim');
  });

  // Losing your place in a list is not the same failure as losing the person,
  // and it should not look like one.
  it('gives the seat to whoever now stands where a departed friend stood', () => {
    expect(keepSeat(cast('ana', 'ben', 'zoe'), 'kim', 1)).toBe('ben');
  });

  it('clamps to the end when the cast has shrunk past the old place', () => {
    expect(keepSeat(cast('ana'), 'kim', 4)).toBe('ana');
  });

  it('has nobody to seat in an empty room', () => {
    expect(keepSeat([], 'kim', 0)).toBeNull();
  });
});

describe('seatAfter', () => {
  it('walks the cast in order', () => {
    expect(seatAfter(cast('kim', 'ana', 'ben'), 'kim')).toBe('ana');
  });

  it('wraps at the end, so everyone gets a turn inside one lap', () => {
    expect(seatAfter(cast('kim', 'ana', 'ben'), 'ben')).toBe('kim');
  });

  it('starts over when the held friend has left the cast', () => {
    expect(seatAfter(cast('kim', 'ana'), 'zoe')).toBe('kim');
  });
});

describe('useHeroSeat', () => {
  it('hands the seat on after the dwell', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHeroSeat(cast('kim', 'ana'), false));
    expect(result.current.seat?.friend.handle).toBe('kim');
    act(() => {
      vi.advanceTimersByTime(DWELL_MS + 100);
    });
    expect(result.current.seat?.friend.handle).toBe('ana');
  });

  // The whole point. While somebody is busy with the card the timer is
  // CLEARED, not paused.
  it('does not change hands while the card is held', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHeroSeat(cast('kim', 'ana'), true));
    act(() => {
      vi.advanceTimersByTime(DWELL_MS * 5);
    });
    expect(result.current.seat?.friend.handle).toBe('kim');
  });

  // A rotation that resumes with two seconds left on the clock is the same
  // rug-pull, just rarer - and therefore harder to believe when it is
  // reported. Releasing the hold starts the dwell again from full.
  it('restarts the dwell from full when the hold is released', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ held }) => useHeroSeat(cast('kim', 'ana'), held), {
      initialProps: { held: false },
    });
    act(() => {
      vi.advanceTimersByTime(DWELL_MS - 1000);
    });
    rerender({ held: true });
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    rerender({ held: false });
    act(() => {
      vi.advanceTimersByTime(DWELL_MS - 2000);
    });
    expect(result.current.seat?.friend.handle).toBe('kim');
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current.seat?.friend.handle).toBe('ana');
  });

  it('never rotates a cast of one', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHeroSeat(cast('kim'), false));
    act(() => {
      vi.advanceTimersByTime(DWELL_MS * 4);
    });
    expect(result.current.seat?.friend.handle).toBe('kim');
  });

  // The cast is rebuilt on every poll and every render. If the countdown were
  // keyed on the array's identity it would be cleared and restarted before it
  // ever reached zero, and the seat would never change hands at all - which
  // looks exactly like a feature nobody built.
  it('survives a cast rebuilt with the same people on every render', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(() => useHeroSeat(cast('kim', 'ana'), false));
    for (let i = 0; i < 5; i++) {
      rerender();
      act(() => {
        vi.advanceTimersByTime(DWELL_MS / 5);
      });
    }
    expect(result.current.seat?.friend.handle).toBe('ana');
  });

  it('seats whoever the rail asks for', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useHeroSeat(cast('kim', 'ana', 'ben'), true));
    act(() => {
      result.current.show('ben');
    });
    expect(result.current.seat?.friend.handle).toBe('ben');
  });

  it('empties the seat when the room does', () => {
    const { result } = renderHook(() => useHeroSeat([], false));
    expect(result.current.seat).toBeNull();
  });
});
