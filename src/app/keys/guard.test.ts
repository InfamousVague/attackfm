import { afterEach, describe, expect, it, vi } from 'vitest';
import { isEditableTarget, kitOverlayOpen, nativelyConsumed } from './guard.ts';

/**
 * Which presses the keyboard listener must leave alone.
 *
 * One global listener is only tolerable if it yields scrupulously: an `S`
 * typed into a playlist name must never press shuffle, and Space on a switch
 * reached by Tab must flip the switch. But it must not yield TOO much either -
 * a button keeps focus after it is clicked, so a guard that handed Space to
 * any focused button pressed "Next" again when the listener meant "pause".
 */

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

/**
 * How focus arrived, the way the guard learns it: a pointer going down, or
 * Tab. Real events at window - `:focus-visible` is not consulted, because a
 * clicked button matches it in Chromium.
 */
function focusFrom(_el: Element, keyboard: boolean) {
  if (keyboard) window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
  else window.dispatchEvent(new Event('pointerdown'));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('a place a person types', () => {
  it('is a text field, a textarea, a select, and anything contenteditable', () => {
    const host = mount(`
      <input id="text" type="text"><input id="search" type="search"><input id="num" type="number">
      <textarea id="area"></textarea><select id="pick"><option>a</option></select>
      <div contenteditable="true"><p><span id="deep">caret</span></p></div>
    `);
    for (const id of ['text', 'search', 'num', 'area', 'pick', 'deep']) {
      expect(isEditableTarget(host.querySelector(`#${id}`)), id).toBe(true);
    }
  });

  it('is anything that SAYS it is a text box, from inside it too', () => {
    const host = mount(`<div role="combobox"><span id="inside">q</span></div>`);
    expect(isEditableTarget(host.querySelector('#inside'))).toBe(true);
  });

  it('is not a checkbox, a range, a button, or the page', () => {
    const host = mount(`<input id="box" type="checkbox"><input id="range" type="range"><button id="b">x</button>`);
    expect(isEditableTarget(host.querySelector('#box'))).toBe(false);
    expect(isEditableTarget(host.querySelector('#range'))).toBe(false);
    expect(isEditableTarget(host.querySelector('#b'))).toBe(false);
    expect(isEditableTarget(document.body)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });

  it('is not a contenteditable turned off', () => {
    const host = mount(`<div contenteditable="false"><span id="off">x</span></div>`);
    expect(isEditableTarget(host.querySelector('#off'))).toBe(false);
  });
});

describe('a key the focused control spends itself', () => {
  it('Space on a switch reached by keyboard is the switch’s', () => {
    const host = mount(`<button role="switch" id="sw">on</button>`);
    const sw = host.querySelector('#sw')!;
    focusFrom(sw, true);
    expect(nativelyConsumed(sw, 'Space')).toBe(true);
    expect(nativelyConsumed(sw, 'Enter')).toBe(true);
  });

  it('Space on a button that was CLICKED is not - it is the music’s', () => {
    // The bug this exists for: click Next, press Space, and Next again.
    const host = mount(`<button id="next">Next</button>`);
    const next = host.querySelector('#next')!;
    focusFrom(next, false);
    expect(nativelyConsumed(next, 'Space')).toBe(false);
  });

  it('arrows on a slider or a tab strip are theirs however the focus arrived', () => {
    const host = mount(`<div role="slider" id="seek" tabindex="0"></div><div role="tablist"><button id="tab">A</button></div>`);
    const seek = host.querySelector('#seek')!;
    const tab = host.querySelector('#tab')!;
    focusFrom(seek, false);
    focusFrom(tab, false);
    expect(nativelyConsumed(seek, 'ArrowRight')).toBe(true);
    expect(nativelyConsumed(tab, 'ArrowLeft')).toBe(true);
  });

  it('a letter is never a control’s, and nothing is spent by the page', () => {
    const host = mount(`<button id="b">x</button>`);
    expect(nativelyConsumed(host.querySelector('#b'), 'M')).toBe(false);
    expect(nativelyConsumed(document.body, 'Space')).toBe(false);
    expect(nativelyConsumed(document.body, 'ArrowRight')).toBe(false);
  });
});

describe('a kit overlay standing', () => {
  it('is a modal, a menu or a listbox in the document', () => {
    expect(kitOverlayOpen()).toBe(false);
    mount(`<div role="dialog" aria-modal="true"></div>`);
    expect(kitOverlayOpen()).toBe(true);
    document.body.innerHTML = '';
    mount(`<div role="menu"></div>`);
    expect(kitOverlayOpen()).toBe(true);
  });

  it('is not a dialog that does not claim modality', () => {
    mount(`<div role="dialog"></div>`);
    expect(kitOverlayOpen()).toBe(false);
  });
});
