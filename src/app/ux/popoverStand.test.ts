import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { STAND_MARK, usePopoverStand } from './popoverStand.ts';

/**
 * The gate, which is the whole of the rule: a popover closes when a layer has
 * COVERED the control it hangs off, and never otherwise. Getting that
 * backwards is a regression this workstream has already had to fix once - the
 * phone's header bell is deliberately live above the palette's top edge, and
 * the docked Now Playing card is deliberately live beside a takeover.
 *
 * And it is asked at BOTH edges, which is the difference between the rule's
 * title and a sweep at one instant: when the popover opens over a layer that
 * is already standing, and when a layer arrives over a popover that is already
 * open. There is no call site to test - the file watches the document itself -
 * so both edges are driven here the way the app drives them: a rerender into
 * `open`, and a node appended to the body.
 *
 * jsdom has no layout and no `elementFromPoint`, so both are supplied here:
 * the trigger gets a box, and the hit test answers with whatever the case
 * under test says is painted at that point. That is precisely the input
 * `underNothing` reads, so the branch being tested is the real one.
 */
function trigger(mark: string, controls?: string): HTMLElement {
  const el = document.createElement('button');
  el.setAttribute(STAND_MARK, mark);
  if (controls) el.setAttribute('aria-controls', controls);
  el.getBoundingClientRect = () => ({ x: 10, y: 10, width: 20, height: 20, top: 10, left: 10, right: 30, bottom: 30 }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

function paints(el: Element | null) {
  Object.defineProperty(document, 'elementFromPoint', { value: () => el, configurable: true });
}

/** A layer arriving: the one thing the watch listens for. Its callback is a
 *  microtask, so the wait is not optional. */
async function layerArrives() {
  await act(async () => {
    document.body.appendChild(document.createElement('div'));
    await Promise.resolve();
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  Reflect.deleteProperty(document, 'elementFromPoint');
});

describe('the popover stand-down rule', () => {
  it('closes a popover when a layer arrives over its trigger', async () => {
    const close = vi.fn();
    const { result } = renderHook(() => usePopoverStand(true, close));
    trigger(result.current);
    paints(document.createElement('div')); // a layer, belonging to nothing here

    await layerArrives();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves one whose trigger a finger can still press', async () => {
    const close = vi.fn();
    const { result } = renderHook(() => usePopoverStand(true, close));
    const el = trigger(result.current);
    paints(el);

    await layerArrives();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes one that opens itself over a layer already standing', () => {
    const close = vi.fn();
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    trigger(result.current);
    paints(document.createElement('div'));

    /* No layer arrives here and nothing is swept: the popover is judged on the
       way up, which is the JamBadge shape - a groove opening its deck from a
       timer while a takeover is already dimming the room. */
    rerender({ open: true });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves one whose own panel is what its trigger's centre hits", () => {
    const close = vi.fn();
    const panel = document.createElement('div');
    panel.id = 'ownPanel';
    document.body.appendChild(panel);
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    trigger(result.current, 'ownPanel');
    paints(panel);

    rerender({ open: true });
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves a closed popover alone, and stops watching when the last one goes', async () => {
    const close = vi.fn();
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: true },
    });
    trigger(result.current);
    paints(document.createElement('div'));

    rerender({ open: false });
    await layerArrives();
    expect(close).not.toHaveBeenCalled();
  });

  it('leaves one whose trigger is not in the document - nothing to judge', async () => {
    const close = vi.fn();
    renderHook(() => usePopoverStand(true, close));
    paints(document.createElement('div'));

    await layerArrives();
    expect(close).not.toHaveBeenCalled();
  });

  it('judges two open popovers one at a time', async () => {
    const covered = vi.fn();
    const reachable = vi.fn();
    const a = renderHook(() => usePopoverStand(true, covered));
    const b = renderHook(() => usePopoverStand(true, reachable));
    trigger(a.result.current);
    const live = trigger(b.result.current);
    /* The one whose own element answers the hit test is reachable; the other
       is not, and the marks are what keep them apart. */
    paints(live);

    await layerArrives();
    expect(covered).toHaveBeenCalledTimes(1);
    expect(reachable).not.toHaveBeenCalled();
  });
});
