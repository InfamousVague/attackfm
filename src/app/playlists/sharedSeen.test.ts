import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  forgetSharedSeen,
  isSharedSeen,
  markSharedSeen,
  sharedSeenKey,
  useSharedSeen,
} from './sharedSeen.ts';

/**
 * "Have I looked at this shared list yet" - the ledger behind the New badge.
 *
 * Module state seeded at import, so each test undoes its own marks; the
 * harness's localStorage wipe clears the disk copy and not the set in memory.
 */
const HUB = 'https://hub.example';
const OTHER = 'https://friend.example';

afterEach(() => {
  for (const hub of [HUB, OTHER, '']) {
    for (const id of ['7', '8', '9']) forgetSharedSeen(hub, id);
  }
});

describe('sharedSeenKey', () => {
  it('keys by hub AND id, because two hubs will both have a list 7', () => {
    expect(sharedSeenKey(HUB, '7')).not.toBe(sharedSeenKey(OTHER, '7'));
  });

  it('gives a local library the empty hub, where nothing is ever shared', () => {
    expect(sharedSeenKey('', '7')).toBe('#7');
  });
});

describe('markSharedSeen', () => {
  it('marks one list on one hub, and only that one', () => {
    markSharedSeen(HUB, '7');
    expect(isSharedSeen(HUB, '7')).toBe(true);
    // The half that makes the line above mean something: the SAME id on
    // another hub is still new.
    expect(isSharedSeen(OTHER, '7')).toBe(false);
    expect(isSharedSeen(HUB, '8')).toBe(false);
  });

  it('is idempotent - a repeat mark writes nothing and notifies nobody', () => {
    // The early return matters because every listener re-renders a shelf, and
    // opening an already-seen list happens far more often than opening a new
    // one. A sentinel in storage is the observable proof that no write ran.
    markSharedSeen(HUB, '7');
    localStorage.setItem('attackfm-playlist-shared-seen', 'sentinel');
    markSharedSeen(HUB, '7');
    expect(localStorage.getItem('attackfm-playlist-shared-seen')).toBe('sentinel');
    // ...whereas a mark that IS new writes, which is what makes that a test.
    markSharedSeen(HUB, '8');
    expect(localStorage.getItem('attackfm-playlist-shared-seen')).not.toBe('sentinel');
  });

  it('survives a relaunch by writing through to storage', () => {
    markSharedSeen(HUB, '7');
    const stored = JSON.parse(
      localStorage.getItem('attackfm-playlist-shared-seen') ?? '[]',
    ) as string[];
    expect(stored).toContain(sharedSeenKey(HUB, '7'));
  });
});

describe('forgetSharedSeen', () => {
  it('makes the next share of the same id new again', () => {
    markSharedSeen(HUB, '7');
    forgetSharedSeen(HUB, '7');
    expect(isSharedSeen(HUB, '7')).toBe(false);
  });

  it('leaves every other mark alone', () => {
    markSharedSeen(HUB, '7');
    markSharedSeen(HUB, '8');
    forgetSharedSeen(HUB, '7');
    expect(isSharedSeen(HUB, '8')).toBe(true);
  });
});


describe('useSharedSeen', () => {
  it('re-renders the shelf when a mark lands while it is one Back away', () => {
    // "The page marks a list seen while the shelf is one Back away and has to
    // be showing the change when you get there."
    const { result } = renderHook(() => useSharedSeen());
    expect(result.current.has(sharedSeenKey(HUB, '7'))).toBe(false);
    act(() => markSharedSeen(HUB, '7'));
    expect(result.current.has(sharedSeenKey(HUB, '7'))).toBe(true);
  });

  it('hands back a STABLE snapshot when nothing moved', () => {
    // useSyncExternalStore compares by identity; a fresh Set per read would
    // loop the shelf until React gave up.
    const { result, rerender } = renderHook(() => useSharedSeen());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('follows a forget too', () => {
    const { result } = renderHook(() => useSharedSeen());
    act(() => markSharedSeen(HUB, '9'));
    act(() => forgetSharedSeen(HUB, '9'));
    expect(result.current.has(sharedSeenKey(HUB, '9'))).toBe(false);
  });
});
