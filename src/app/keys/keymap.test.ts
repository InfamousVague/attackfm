import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Which chord each action answers to, and what is kept of a person's changes.
 *
 * The store snapshots localStorage at import, so every test gets a fresh
 * module over whatever storage it set up first.
 */
async function fresh(stored?: unknown) {
  if (stored !== undefined) localStorage.setItem('attackfm-keymap', JSON.stringify(stored));
  vi.resetModules();
  return import('./keymap.ts');
}

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('the shipped map', () => {
  it('answers Space with play/pause and the arrows with seek and volume', async () => {
    const k = await fresh();
    expect(k.chordFor('playPause')).toBe('Space');
    expect(k.chordFor('seekForward')).toBe('ArrowRight');
    expect(k.chordFor('next')).toBe('shift+ArrowRight');
    expect(k.chordFor('volumeUp')).toBe('ArrowUp');
    expect(k.actionForChord('Space')).toBe('playPause');
    expect(k.customBindingCount()).toBe(0);
  });

  it('has no two actions on one chord', async () => {
    const k = await fresh();
    expect(k.bindingConflicts().size).toBe(0);
  });

  it('stores nothing at all until something is changed', async () => {
    await fresh();
    expect(localStorage.getItem('attackfm-keymap')).toBeNull();
  });
});

describe('changing a binding', () => {
  it('stores only the change, spelled canonically', async () => {
    const k = await fresh();
    k.setBinding('shuffle', 'shift+mod+s');
    expect(k.chordFor('shuffle')).toBe('mod+shift+S');
    expect(JSON.parse(localStorage.getItem('attackfm-keymap')!)).toEqual({ shuffle: 'mod+shift+S' });
    expect(k.customBindingCount()).toBe(1);
    expect(k.isShippedBinding('shuffle')).toBe(false);
  });

  it('switches an action off with null, and nothing answers its old chord', async () => {
    const k = await fresh();
    k.setBinding('mute', null);
    expect(k.chordFor('mute')).toBeNull();
    expect(k.actionForChord('M')).toBeNull();
  });

  it('treats rebinding to the shipped chord as a reset', async () => {
    const k = await fresh();
    k.setBinding('repeat', 'mod+R');
    k.setBinding('repeat', 'R');
    expect(k.isShippedBinding('repeat')).toBe(true);
    expect(localStorage.getItem('attackfm-keymap')).toBeNull();
  });

  it('refuses a chord that names nothing a keyboard can press', async () => {
    const k = await fresh();
    k.setBinding('like', 'shift');
    expect(k.chordFor('like')).toBe('L');
  });

  it('resets one row, or all of them', async () => {
    const k = await fresh();
    k.setBinding('like', 'mod+L');
    k.setBinding('queue', 'mod+Q');
    k.resetBinding('like');
    expect(k.chordFor('like')).toBe('L');
    expect(k.chordFor('queue')).toBe('mod+Q');
    k.resetAllBindings();
    expect(k.customBindingCount()).toBe(0);
    expect(localStorage.getItem('attackfm-keymap')).toBeNull();
  });

  it('wakes whatever is drawing the map', async () => {
    const k = await fresh();
    const { renderHook, act } = await import('@testing-library/react');
    const { result } = renderHook(() => k.useKeymap());
    act(() => k.setBinding('mute', 'mod+M'));
    expect(result.current.mute).toBe('mod+M');
  });
});

describe('two actions on one chord', () => {
  it('is allowed, named beside both rows, and the first in the catalogue wins', async () => {
    const k = await fresh();
    k.setBinding('like', 'S');
    const conflicts = k.bindingConflicts();
    expect(conflicts.get('shuffle')).toEqual(['like']);
    expect(conflicts.get('like')).toEqual(['shuffle']);
    expect(k.actionForChord('S')).toBe('shuffle');
  });
});

describe('what was stored', () => {
  it('drops a bad entry without taking the good ones down with it', async () => {
    const k = await fresh({ mute: 'mod+M', like: 'bogus+L', gone: 'mod+G', queue: 42 });
    expect(k.chordFor('mute')).toBe('mod+M');
    expect(k.chordFor('like')).toBe('L');
    expect(k.chordFor('queue')).toBe('Q');
  });

  it('survives storage that is not a keymap at all', async () => {
    localStorage.setItem('attackfm-keymap', '[not json');
    vi.resetModules();
    const k = await import('./keymap.ts');
    expect(k.chordFor('playPause')).toBe('Space');
  });

  it('follows a change made elsewhere - the sync writes and dispatches `storage`', async () => {
    const k = await fresh();
    localStorage.setItem('attackfm-keymap', JSON.stringify({ search: 'mod+F' }));
    window.dispatchEvent(new StorageEvent('storage', { key: 'attackfm-keymap' }));
    expect(k.chordFor('search')).toBe('mod+F');
  });
});
