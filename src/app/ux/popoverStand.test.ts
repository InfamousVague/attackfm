import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { STAND_MARK, standDownCoveredPopovers, usePopoverStand } from './popoverStand.ts';

/**
 * The gate, which is the whole of the rule: a popover closes when a takeover
 * has COVERED the control it hangs off, and never otherwise. Getting that
 * backwards is a regression this workstream has already had to fix once - the
 * phone's header bell is deliberately live above the palette's top edge, and
 * the docked Now Playing card is deliberately live beside a takeover.
 *
 * jsdom has no layout and no `elementFromPoint`, so both are supplied here:
 * the trigger gets a box, and the hit test answers with whatever the case
 * under test says is painted at that point. That is precisely the input
 * `underNothing` reads, so the branch being tested is the real one.
 */
function trigger(mark: string): HTMLElement {
  const el = document.createElement('button');
  el.setAttribute(STAND_MARK, mark);
  el.getBoundingClientRect = () => ({ x: 10, y: 10, width: 20, height: 20, top: 10, left: 10, right: 30, bottom: 30 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function paints(el: Element | null) {
  Object.defineProperty(document, 'elementFromPoint', { value: () => el, configurable: true });
}

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('standDownCoveredPopovers', () => {
  it('closes a popover whose trigger something is painted over', () => {
    const close = vi.fn();
    const { result } = renderHook(() => usePopoverStand(true, close));
    trigger(result.current);
    paints(document.createElement('div')); // a layer, belonging to nothing here

    standDownCoveredPopovers();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves one whose trigger a finger can still press', () => {
    const close = vi.fn();
    const { result } = renderHook(() => usePopoverStand(true, close));
    const el = trigger(result.current);
    paints(el);

    standDownCoveredPopovers();
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves a closed popover alone, and forgets it when it closes', () => {
    const close = vi.fn();
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: true },
    });
    trigger(result.current);
    paints(document.createElement('div'));

    rerender({ open: false });
    standDownCoveredPopovers();
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves one whose trigger is not in the document - nothing to judge', () => {
    const close = vi.fn();
    renderHook(() => usePopoverStand(true, close));
    paints(document.createElement('div'));

    standDownCoveredPopovers();
    expect(close).not.toHaveBeenCalled();
  });

  it('judges two open popovers one at a time', () => {
    const covered = vi.fn();
    const reachable = vi.fn();
    const a = renderHook(() => usePopoverStand(true, covered));
    const b = renderHook(() => usePopoverStand(true, reachable));
    trigger(a.result.current);
    const live = trigger(b.result.current);
    /* The one whose own element answers the hit test is reachable; the other
       is not, and the marks are what keep them apart. */
    paints(live);

    standDownCoveredPopovers();
    expect(covered).toHaveBeenCalledTimes(1);
    expect(reachable).not.toHaveBeenCalled();
  });
});
