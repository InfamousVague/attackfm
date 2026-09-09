import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSheetScrim } from './useSheetScrim.ts';

/**
 * The sheet contract's one bit, as the markup reads it.
 *
 * This is here because the Browser pane CANNOT test it: that pane fires no
 * `resize` and no `matchMedia` change events at all - measured, a 1280 -> 375
 * crossing flipped `matches` true -> false with zero listener calls - so the
 * reactive half of this hook is unobservable there. jsdom will at least run
 * the wiring if it is handed a query it can drive.
 *
 * Two rules, and the second is the one a refactor would break: the hook READS
 * THE TOKEN on every change rather than trusting the query's own `matches`.
 * The token has a second branch (`:root[data-platform='desktop']`) that the
 * query knows nothing about, and a hook that answered from `matches` would
 * report no dimmer for a narrow desktop browser window that has one.
 */
type Listener = () => void;

function stubMedia(): { queries: string[]; fire: () => void } {
  const queries: string[] = [];
  const listeners = new Set<Listener>();
  vi.stubGlobal('matchMedia', (query: string) => {
    queries.push(query);
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener: (_: string, fn: Listener) => listeners.add(fn),
      removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  });
  return { queries, fire: () => listeners.forEach((fn) => fn()) };
}

const token = (value: string) => document.documentElement.style.setProperty('--app-sheet-scrim', value);

afterEach(() => {
  document.documentElement.style.removeProperty('--app-sheet-scrim');
  vi.unstubAllGlobals();
});

describe('useSheetScrim', () => {
  it('reads the contract token, not a copy of its media query', () => {
    stubMedia();
    token('none');
    expect(renderHook(() => useSheetScrim()).result.current).toBe(false);

    token('block');
    expect(renderHook(() => useSheetScrim()).result.current).toBe(true);
  });

  it('watches the contract shape', () => {
    const media = stubMedia();
    token('none');
    renderHook(() => useSheetScrim());
    expect(media.queries).toContain('(min-width: 60rem) and (pointer: fine)');
  });

  it('re-reads the token when the query changes, rather than trusting the event', () => {
    const media = stubMedia();
    token('none');
    const { result } = renderHook(() => useSheetScrim());
    expect(result.current).toBe(false);

    /* The stub's `matches` stays false throughout: only the TOKEN moves, which
       is exactly the desktop-platform branch the query cannot see. */
    token('block');
    act(() => media.fire());
    expect(result.current).toBe(true);

    token('none');
    act(() => media.fire());
    expect(result.current).toBe(false);
  });

  it('stops listening when it goes away', () => {
    const media = stubMedia();
    token('none');
    const { result, unmount } = renderHook(() => useSheetScrim());
    unmount();
    token('block');
    media.fire();
    expect(result.current).toBe(false);
  });
});
