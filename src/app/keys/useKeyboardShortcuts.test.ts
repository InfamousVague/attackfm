import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setKeyboardDeck, type KeyboardDeck } from './deckDoor.ts';
import { handleKeyEvent } from './useKeyboardShortcuts.ts';
import { resetAllBindings, setBinding } from './keymap.ts';
import { isMacLike } from './chords.ts';

/**
 * The listener's body, fed real KeyboardEvents dispatched at real elements -
 * the target is the thing every guard reads, so it is never faked.
 */

function stubDeck() {
  const deck: KeyboardDeck = {
    togglePlay: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    seekBy: vi.fn(),
    volumeBy: vi.fn(),
    toggleMute: vi.fn(),
    cycleShuffle: vi.fn(),
    cycleRepeat: vi.fn(),
    toggleFavourite: vi.fn(),
    toggleQueue: vi.fn(),
    toggleNowPlaying: vi.fn(),
  };
  setKeyboardDeck(() => deck);
  return deck;
}

const deps = () => ({ openSearch: vi.fn(), closeTop: vi.fn(() => true) });

/** Press at `target`, the way the browser delivers it to window's listener. */
function press(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  let handled = false;
  const d = deps();
  const listener = (e: Event) => {
    handled = handleKeyEvent(e as KeyboardEvent, d);
  };
  window.addEventListener('keydown', listener);
  target.dispatchEvent(event);
  window.removeEventListener('keydown', listener);
  return { handled, prevented: event.defaultPrevented, deps: d };
}

const mod = isMacLike ? { metaKey: true } : { ctrlKey: true };

beforeEach(() => {
  localStorage.clear();
  resetAllBindings();
});

afterEach(() => {
  setKeyboardDeck(null);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('a press on the page', () => {
  it('Space plays or pauses, and is spent so the page does not scroll', () => {
    const deck = stubDeck();
    const r = press(document.body, { key: ' ' });
    expect(deck.togglePlay).toHaveBeenCalledOnce();
    expect(r.handled).toBe(true);
    expect(r.prevented).toBe(true);
  });

  it('the arrows seek and turn it up, and Shift+arrow changes the song', () => {
    const deck = stubDeck();
    press(document.body, { key: 'ArrowRight' });
    press(document.body, { key: 'ArrowLeft' });
    press(document.body, { key: 'ArrowUp' });
    press(document.body, { key: 'ArrowRight', shiftKey: true });
    expect(deck.seekBy).toHaveBeenNthCalledWith(1, 5);
    expect(deck.seekBy).toHaveBeenNthCalledWith(2, -5);
    expect(deck.volumeBy).toHaveBeenCalledWith(5);
    expect(deck.next).toHaveBeenCalledOnce();
  });

  it('a held arrow keeps seeking; a held Space does not flutter the deck', () => {
    const deck = stubDeck();
    press(document.body, { key: 'ArrowRight', repeat: true });
    expect(deck.seekBy).toHaveBeenCalledOnce();
    const held = press(document.body, { key: ' ', repeat: true });
    expect(deck.togglePlay).not.toHaveBeenCalled();
    // Still spent, or the second repeat scrolls the page.
    expect(held.prevented).toBe(true);
  });

  it('/ opens search, including on a layout where it takes Shift', () => {
    stubDeck();
    expect(press(document.body, { key: '/' }).deps.openSearch).toHaveBeenCalledOnce();
    expect(press(document.body, { key: '/', shiftKey: true }).deps.openSearch).toHaveBeenCalledOnce();
  });

  it('does nothing and spends nothing with no Player standing', () => {
    const r = press(document.body, { key: ' ' });
    expect(r.handled).toBe(false);
    expect(r.prevented).toBe(false);
  });

  it('leaves a chord nobody bound alone', () => {
    const deck = stubDeck();
    const r = press(document.body, { key: 'k' });
    expect(r.handled).toBe(false);
    expect(Object.values(deck).every((fn) => (fn as ReturnType<typeof vi.fn>).mock.calls.length === 0)).toBe(true);
  });
});

describe('presses that are not the music’s', () => {
  it('a letter typed into a field is typed, not shuffled', () => {
    const deck = stubDeck();
    document.body.innerHTML = `<input id="name" type="text">`;
    const r = press(document.querySelector('#name')!, { key: 's' });
    expect(deck.cycleShuffle).not.toHaveBeenCalled();
    expect(r.prevented).toBe(false);
  });

  it('a press something already spent is left spent', () => {
    const deck = stubDeck();
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    event.preventDefault();
    expect(handleKeyEvent(event, deps())).toBe(false);
    expect(deck.togglePlay).not.toHaveBeenCalled();
  });

  it('Space on a switch reached by Tab flips the switch', () => {
    const deck = stubDeck();
    document.body.innerHTML = `<button role="switch" id="sw">x</button>`;
    const sw = document.querySelector('#sw')!;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    press(sw, { key: ' ' });
    expect(deck.togglePlay).not.toHaveBeenCalled();
  });

  it('Space on a button that was just CLICKED pauses rather than pressing it again', () => {
    const deck = stubDeck();
    document.body.innerHTML = `<button id="next">Next</button>`;
    const next = document.querySelector('#next')!;
    // A click, as far as the guard can tell - and a keyboard walk BEFORE it,
    // which the click must override.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    window.dispatchEvent(new Event('pointerdown'));
    const r = press(next, { key: ' ' });
    expect(deck.togglePlay).toHaveBeenCalledOnce();
    expect(r.prevented).toBe(true);
  });

  it('Escape belongs to a kit menu while one is open', () => {
    stubDeck();
    document.body.innerHTML = `<div role="menu"></div>`;
    const r = press(document.body, { key: 'Escape' });
    expect(r.deps.closeTop).not.toHaveBeenCalled();
    expect(r.handled).toBe(false);
  });

  it('Escape with nothing on top is not spent', () => {
    stubDeck();
    const d = { openSearch: vi.fn(), closeTop: vi.fn(() => false) };
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    expect(handleKeyEvent(event, d)).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });

  it('a mod chord is never yielded to a focused control', () => {
    const deck = stubDeck();
    setBinding('next', 'mod+ArrowRight');
    document.body.innerHTML = `<div role="slider" id="seek" tabindex="0"></div>`;
    press(document.querySelector('#seek')!, { key: 'ArrowRight', ...mod });
    expect(deck.next).toHaveBeenCalledOnce();
  });
});

describe('a rebound key', () => {
  it('answers on the very next press, and the old one stops', () => {
    const deck = stubDeck();
    setBinding('playPause', 'K');
    press(document.body, { key: ' ' });
    expect(deck.togglePlay).not.toHaveBeenCalled();
    press(document.body, { key: 'k' });
    expect(deck.togglePlay).toHaveBeenCalledOnce();
  });
});
