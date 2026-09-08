import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { sharingEnabled, setSharing, useSharing } from './sharingPref.ts';

/**
 * The one switch in this app whose default is ON.
 *
 * That makes both halves of it load-bearing in a way an ordinary preference
 * is not. Read it wrong and somebody who turned sharing OFF is broadcasting
 * their week to their friends again - which is not a bug you notice, because
 * the app looks the same either way. Write it under a different key and every
 * device on earth silently forgets the choice its owner made and reverts to
 * on, which is the same failure arriving by a different door.
 *
 * So this file pins three things: the exact key, that only the literal word
 * `off` is a refusal, and that a store which refuses to answer at all still
 * lands on the shipped default rather than throwing into a component's
 * render.
 */

/** The key on disk. Spelled out rather than imported: the point of the test is
 *  that THIS string is what devices already hold, so reading it from the module
 *  would let a rename pass unnoticed. */
const KEY = 'attackfm-share-listening';

describe('the stored value', () => {
  it('is on for somebody who has never been asked', () => {
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(sharingEnabled()).toBe(true);
  });

  it('honours an explicit off, and only the literal word', () => {
    // The rule is "anything that is not `off` is on" - a value from an older
    // build, a half-written key, a stray 'false' - because the only state
    // worth trusting from a stranger is a refusal that was spelled exactly.
    localStorage.setItem(KEY, 'off');
    expect(sharingEnabled()).toBe(false);
    localStorage.setItem(KEY, 'false');
    expect(sharingEnabled()).toBe(true);
    localStorage.setItem(KEY, 'OFF');
    expect(sharingEnabled()).toBe(true);
  });

  it('WRITES THE KEY DEVICES ALREADY HOLD', () => {
    // Rename the key and nothing fails: the app reads a missing value, falls
    // back to the default, and turns sharing back on for everybody who had
    // switched it off. This assertion is the only thing standing in the way.
    setSharing(false);
    expect(localStorage.getItem(KEY)).toBe('off');
    setSharing(true);
    expect(localStorage.getItem(KEY)).toBe('on');
  });

  it('survives a round trip in both directions', () => {
    setSharing(false);
    expect(sharingEnabled()).toBe(false);
    setSharing(true);
    expect(sharingEnabled()).toBe(true);
  });
});

describe('a store that will not answer', () => {
  it('reads as ON rather than throwing into a render', () => {
    // Private mode, or a browser configured to block site data. `useSharing`
    // calls this during render through useSyncExternalStore, so a throw here
    // blanks whatever page was showing the switch.
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(sharingEnabled()).toBe(true);
  });

  it('lets the choice apply for this run even when it cannot be saved', () => {
    // Quota, or the same locked-down store. The write is lost; the throw must
    // not be, or turning the switch off takes the page down with it.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
    expect(() => setSharing(false)).not.toThrow();
  });
});

describe('useSharing', () => {
  it('moves every surface showing the switch, not just the one that flipped it', () => {
    /*
     * There are four: the Privacy pane, the settings rail's summary line, the
     * Friends section and the Profile page. They are not one component and
     * they do not share a provider - the store below is what keeps them
     * agreeing. Drop the notify loop from `setSharing` and each of them keeps
     * showing whatever it read when it mounted, so the switch appears to work
     * on the pane you are looking at and appears stuck everywhere else.
     */
    const first = renderHook(() => useSharing());
    const second = renderHook(() => useSharing());
    expect(first.result.current).toBe(true);

    act(() => setSharing(false));
    expect(first.result.current).toBe(false);
    expect(second.result.current).toBe(false);

    act(() => setSharing(true));
    expect(first.result.current).toBe(true);
    expect(second.result.current).toBe(true);
  });

  it('stops listening once the component that asked is gone', () => {
    // The subscribe callback returns its own removal; lose it and the set
    // grows for the life of the session, and React is asked to re-render
    // components that unmounted.
    const { result, unmount } = renderHook(() => useSharing());
    unmount();
    expect(() => act(() => setSharing(false))).not.toThrow();
    expect(result.current).toBe(true);
  });

  it('starts from what is on disk, not from the default', () => {
    localStorage.setItem('attackfm-share-listening', 'off');
    const { result } = renderHook(() => useSharing());
    expect(result.current).toBe(false);
  });
});
