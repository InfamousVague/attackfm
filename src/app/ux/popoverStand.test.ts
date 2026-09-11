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
 * so both edges are driven here the way the app drives them, and the opening
 * edge is the one that has to be driven carefully. The kit portals the panel a
 * commit AFTER it marks the trigger, so a rerender into `open` with the panel
 * already in the document is a state the app cannot reach; what the app
 * reaches is a rerender into `open` and THEN the panel's arrival, which is
 * itself the node the watch listens for. `opens()` does exactly that, in that
 * order, which is why it is the only way this file opens one.
 *
 * jsdom has no layout and no `elementFromPoint`, so both are supplied here:
 * the trigger gets a box, and the hit test answers with whatever the case
 * under test says is painted at that point. That is precisely the input
 * `underNothing` reads, so the branch being tested is the real one.
 */
const box = (x: number) =>
  ({ x, y: 10, width: 20, height: 20, top: 10, left: x, right: x + 20, bottom: 30 }) as DOMRect;

function trigger(mark: string, controls?: string, x = 10): HTMLElement {
  const el = document.createElement('button');
  el.setAttribute(STAND_MARK, mark);
  if (controls) el.setAttribute('aria-controls', controls);
  el.getBoundingClientRect = () => box(x);
  document.body.appendChild(el);
  return el;
}

/** What is painted at a point. A single element answers every point, which is
 *  all most cases need; a function answers by x, for the one case that has to
 *  say "the trigger is covered but the field beside it is not". */
function paints(el: Element | null | ((x: number, y: number) => Element | null)) {
  const at = typeof el === 'function' ? el : () => el;
  Object.defineProperty(document, 'elementFromPoint', { value: at, configurable: true });
}

/** The panel the kit portals a commit after the trigger is marked. Returned so
 *  a case can say the hit lands on it. */
function panelFor(id: string): HTMLElement {
  const el = document.createElement('div');
  el.id = id;
  return el;
}

/** A layer arriving: the one thing the watch listens for. Its callback is a
 *  microtask, so the wait is not optional. */
async function layerArrives(node: HTMLElement = document.createElement('div')) {
  await act(async () => {
    document.body.appendChild(node);
    await Promise.resolve();
  });
}

/**
 * The opening edge, in the order the app reaches it: the trigger is marked in
 * one commit and the panel is portalled in the next, so the panel's arrival IS
 * the layer record the watch is armed for. `takesFocus` reproduces the other
 * thing the kit does as that panel mounts.
 */
async function opens(
  rerender: (props: { open: boolean }) => void,
  panel: HTMLElement,
  takesFocus = false,
) {
  rerender({ open: true });
  await act(async () => {
    document.body.appendChild(panel);
    if (takesFocus) {
      panel.tabIndex = -1;
      panel.focus();
    }
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
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    const el = trigger(result.current, 'panel');
    paints(el); // nothing over it while it opens
    await opens(rerender, panelFor('panel'));
    expect(close).not.toHaveBeenCalled();

    paints(document.createElement('div')); // a layer, belonging to nothing here
    await layerArrives();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('leaves one whose trigger a finger can still press', async () => {
    const close = vi.fn();
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    const el = trigger(result.current, 'panel');
    paints(el);

    await opens(rerender, panelFor('panel'));
    await layerArrives();
    expect(close).not.toHaveBeenCalled();
  });

  it('closes one that opens itself over a layer already standing - when its panel lands', async () => {
    const close = vi.fn();
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    trigger(result.current, 'panel');
    paints(document.createElement('div'));

    /* The JamBadge shape: a groove opening its deck from a timer while a
       takeover is already dimming the room. No OTHER layer arrives here - the
       node that judges this one is the popover's own panel. */
    rerender({ open: true });
    expect(close).not.toHaveBeenCalled(); // a commit too early: there is no panel yet
    await layerArrives(panelFor('panel'));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("leaves one whose own panel is what its trigger's centre hits", async () => {
    const close = vi.fn();
    const panel = panelFor('panel');
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    trigger(result.current, 'panel');
    paints(panel);

    await opens(rerender, panel);
    await layerArrives(); // and again on an ordinary sweep, where `own` is live
    expect(close).not.toHaveBeenCalled();
  });

  it('judges nothing while the panel is still on its way', async () => {
    const close = vi.fn();
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    trigger(result.current, 'panel'); // marked, but the kit has not portalled yet
    paints(document.createElement('div'));

    rerender({ open: true });
    await layerArrives(); // a takeover lands in that gap
    expect(close).not.toHaveBeenCalled();
  });

  it('hands focus back to whoever held it when it closes a panel that took it', async () => {
    const close = vi.fn();
    const field = document.createElement('input');
    field.getBoundingClientRect = () => box(200);
    document.body.appendChild(field);
    field.focus();
    /* The trigger's centre is covered and the field's is not, which is the
       whole of what `rehome` asks before it puts focus anywhere. */
    const cover = document.createElement('div');
    paints((x) => (x < 100 ? cover : field));

    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    trigger(result.current, 'panel');
    await opens(rerender, panelFor('panel'), true);

    expect(close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(field);
  });

  it('drops focus to the document when there is nowhere reachable to put it back', async () => {
    const close = vi.fn();
    paints(document.createElement('div')); // nothing here is reachable, the trigger included
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    trigger(result.current, 'panel').focus(); // a press left focus on the trigger
    await opens(rerender, panelFor('panel'), true);

    expect(close).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.body);
  });

  it('leaves focus alone when the takeover has already taken it', async () => {
    const close = vi.fn();
    paints(document.createElement('div'));
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    trigger(result.current, 'panel');
    await opens(rerender, panelFor('panel'));
    /* Focus is not in our panel - a kit Modal's own trap has it - so this rule
       has no business moving it. */
    const theirs = document.createElement('button');
    document.body.appendChild(theirs);
    theirs.focus();
    await layerArrives();

    expect(close).toHaveBeenCalled();
    expect(document.activeElement).toBe(theirs);
  });

  it('leaves a closed popover alone, and stops watching when the last one goes', async () => {
    const close = vi.fn();
    const { rerender, result } = renderHook(({ open }) => usePopoverStand(open, close), {
      initialProps: { open: false },
    });
    const el = trigger(result.current, 'panel');
    paints(el);
    await opens(rerender, panelFor('panel'));

    rerender({ open: false });
    paints(document.createElement('div'));
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
    const a = renderHook(({ open }) => usePopoverStand(open, covered), {
      initialProps: { open: false },
    });
    const b = renderHook(({ open }) => usePopoverStand(open, reachable), {
      initialProps: { open: false },
    });
    const dead = trigger(a.result.current, 'panelA', 10);
    const live = trigger(b.result.current, 'panelB', 200);
    // Both open uncovered: each trigger's centre hits itself.
    paints((x) => (x < 100 ? dead : live));
    await opens(a.rerender, panelFor('panelA'));
    await opens(b.rerender, panelFor('panelB'));
    expect(covered).not.toHaveBeenCalled();
    expect(reachable).not.toHaveBeenCalled();

    /* Now one of them is covered. The one whose own element answers the hit
       test is reachable; the other is not, and the marks are what keep them
       apart. */
    paints(live);
    await layerArrives();
    expect(covered).toHaveBeenCalledTimes(1);
    expect(reachable).not.toHaveBeenCalled();
  });
});
