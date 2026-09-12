import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SPLIT_SHAPE, useSplitViewport } from './useSplitViewport.ts';

/**
 * A matchMedia whose answer this file controls, and whose listeners it can
 * fire - the setup file's default answers NO to everything and never calls a
 * listener, which is the right default and useless for a hook whose whole job
 * is to follow the hinge.
 */
function hinge(initial: boolean) {
  const listeners = new Set<() => void>();
  const list = {
    matches: initial,
    media: SPLIT_SHAPE,
    onchange: null,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  const asked: string[] = [];
  vi.stubGlobal('matchMedia', (query: string) => {
    asked.push(query);
    return list as unknown as MediaQueryList;
  });
  return {
    asked,
    fold: (open: boolean) => {
      list.matches = open;
      listeners.forEach((fn) => fn());
    },
    listeners,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSplitViewport', () => {
  it('asks about room alone - no pointer, no aspect', () => {
    const { asked } = hinge(false);
    renderHook(() => useSplitViewport());
    expect(asked).toContain(SPLIT_SHAPE);
    expect(SPLIT_SHAPE).not.toMatch(/pointer|hover|aspect/);
    // 48rem across: over every phone in portrait, under every fold opened
    // sideways and every tablet. 32rem down: over the fold (~700) and every
    // tablet, under every phone held sideways (~420). The numbers are the
    // decision; a change to either should have to change this line too.
    expect(SPLIT_SHAPE).toBe('(min-width: 48rem) and (min-height: 32rem)');
  });

  it('follows the hinge live, both ways', () => {
    const h = hinge(false);
    const { result, unmount } = renderHook(() => useSplitViewport());
    expect(result.current).toBe(false);

    act(() => h.fold(true));
    expect(result.current).toBe(true);

    act(() => h.fold(false));
    expect(result.current).toBe(false);

    unmount();
    expect(h.listeners.size).toBe(0);
  });
});
