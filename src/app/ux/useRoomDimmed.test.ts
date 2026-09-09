import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRoomDimmed } from './useRoomDimmed.ts';

/**
 * The one bit `aria-modal="true"` rides on, and the shape of the failure it
 * replaced: the hook used to read the sheet contract's token, which answers
 * "does a dimmer paint at all" and not "does it cover everything the ring will
 * hand focus to". The two diverge on a docked desktop, where the dimmer stops
 * at the app column on purpose. So every case below is a BOX, and the docked
 * one carries the numbers measured in the real app at 1280x720.
 *
 * This is here because the Browser pane CANNOT test the reactive half: that
 * pane fires no `resize` and no `matchMedia` change events at all - measured,
 * a 1280 -> 375 crossing flipped `matches` true -> false with zero listener
 * calls. jsdom has no layout and no ResizeObserver either, so both are
 * supplied: the element is given the box the case is about, and the observer
 * is a spy that hands back its own callback to fire.
 */
type Read = () => void;

function stubObserver(): { reads: Read[]; fire: () => void; disconnected: () => number } {
  const reads: Read[] = [];
  let disconnects = 0;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(read: Read) {
        reads.push(read);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        disconnects += 1;
      }
    },
  );
  return { reads, fire: () => act(() => reads.forEach((read) => read())), disconnected: () => disconnects };
}

/** An element with a box and nothing else - which is all this hook reads. */
function dimmer(x: number, y: number, width: number, height: number): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ x, y, width, height, top: y, left: x, right: x + width, bottom: y + height }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

const room = (width: number, height: number) => {
  vi.stubGlobal('innerWidth', width);
  vi.stubGlobal('innerHeight', height);
};

function hand(el: HTMLElement | null) {
  const view = renderHook(() => useRoomDimmed());
  act(() => view.result.current[0](el));
  return view;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('useRoomDimmed', () => {
  it('claims a room the dimmer covers', () => {
    stubObserver();
    room(1280, 720);
    expect(hand(dimmer(0, 0, 1280, 720)).result.current[1]).toBe(true);
  });

  it('withholds it where the dimmer stops at the app column - the docked desktop', () => {
    stubObserver();
    room(1280, 720);
    /* The measured shape: chapter 05 narrows every takeover to the app column
       so the docked card keeps its own controls, and the focus ring keeps them
       too. 793.602 of 1280. */
    expect(hand(dimmer(0, 0, 793.602, 720)).result.current[1]).toBe(false);
  });

  it('withholds it where the contract paints no dimmer at all', () => {
    stubObserver();
    room(375, 812);
    /* `display: none` measures 0 x 0 - a phone, and a docked tablet. */
    expect(hand(dimmer(0, 0, 0, 0)).result.current[1]).toBe(false);
  });

  it('withholds it when there is nothing to measure', () => {
    stubObserver();
    room(1280, 720);
    /* The direction the token read got wrong: it answered TRUE for a property
       it could not read. */
    expect(hand(null).result.current[1]).toBe(false);
  });

  it('re-reads the box when it changes, which is how docking is heard at all', () => {
    const observer = stubObserver();
    room(1280, 720);
    let width = 793.602;
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({ x: 0, y: 0, width, height: 720, top: 0, left: 0, right: width, bottom: 720 }) as DOMRect;
    document.body.appendChild(el);

    const view = hand(el);
    expect(view.result.current[1]).toBe(false);

    /* Undocking fires no event of its own - the width is a `:has()` rule's
       custom property - so the observer is the only thing that hears it. */
    width = 1280;
    observer.fire();
    expect(view.result.current[1]).toBe(true);
  });

  it('re-reads when the room changes around a dimmer that did not move', () => {
    stubObserver();
    room(1280, 720);
    const view = hand(dimmer(0, 0, 1280, 720));
    expect(view.result.current[1]).toBe(true);

    room(1600, 900);
    act(() => window.dispatchEvent(new Event('resize')));
    expect(view.result.current[1]).toBe(false);
  });

  it('stops watching when the dialog goes', () => {
    const observer = stubObserver();
    room(1280, 720);
    const view = hand(dimmer(0, 0, 1280, 720));
    expect(observer.disconnected()).toBe(0);
    view.unmount();
    expect(observer.disconnected()).toBe(1);
  });
});
