/**
 * Which presses are not ours.
 *
 * A single global listener is only tolerable if it is scrupulous about
 * yielding: the letter S typed into a playlist's name must never press
 * shuffle, and an arrow on a focused tab strip must move the tabs, not the
 * song. These two questions are asked of every key event before any chord is
 * looked up, and they are plain functions of the target so a test can ask
 * them of a fixture element without a keyboard in the room.
 */

/**
 * Input types that take TEXT. Anything else - a checkbox, a slider, a button
 * dressed as an input - is a control, and is judged by `nativelyConsumed`
 * below rather than treated as a field.
 */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'week',
  'time',
]);

/** Roles that mean "typing goes here" whatever element carries them. */
const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

/**
 * Is this somewhere a person types?
 *
 * Text inputs, textareas, selects (typing selects an option), anything
 * contenteditable and anything that SAYS it is a text box. Checked on the
 * target and on its ancestors: a caret inside a rich editor sits on a span
 * three levels under the element that carries the attribute.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target instanceof HTMLInputElement) {
    const type = (target.type || 'text').toLowerCase();
    return TEXT_INPUT_TYPES.has(type);
  }
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const role = target.closest('[role]')?.getAttribute('role') ?? '';
  if (EDITABLE_ROLES.has(role)) return true;
  return target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/**
 * Keys whose meaning on a focused control the browser (or the kit) already
 * spends. Space and Enter press the button under the caret; the arrows walk a
 * tab strip, a menu, a slider, a radio group. A plain-key chord bound to one
 * of these must yield when the focus is on something that consumes it, or a
 * person tabbing to a switch and pressing Space would start the music
 * instead of flipping the switch.
 */
const PRESS_KEYS = new Set(['Space', 'Enter']);
const WALK_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);

/** What Space and Enter activate. Selectors, never shown. i18n-ignore */
const PRESSABLE =
  'button, a[href], summary, input, [role="button"], [role="switch"], [role="checkbox"], [role="radio"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="tab"], [role="link"]';

/** What the arrows and Home/End move through. Selectors, never shown. i18n-ignore */
const WALKABLE =
  'input, select, [role="slider"], [role="tab"], [role="tablist"], [role="menu"], [role="menubar"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="listbox"], [role="option"], [role="radio"], [role="radiogroup"], [role="tree"], [role="treeitem"], [role="grid"], [role="gridcell"], [role="scrollbar"]';

/**
 * Would the focused control spend this key itself?
 *
 * Only for a chord with no modifier: `mod+ArrowRight` on a slider is not a
 * step, and there is no button whose native meaning is Shift+Space. And for
 * Space and Enter, only when the focus arrived by keyboard - see below. The
 * element is matched against its ancestors too - a kit tab's focus target is
 * the button INSIDE the element carrying `role="tab"`.
 */
export function nativelyConsumed(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof Element)) return false;
  if (PRESS_KEYS.has(key)) return target.closest(PRESSABLE) !== null && keyboardFocused();
  if (WALK_KEYS.has(key)) return target.closest(WALKABLE) !== null;
  return false;
}

/*
 * HOW THE FOCUS GOT THERE, tracked rather than asked.
 *
 * A button keeps focus after it is clicked. So a guard that handed Space to
 * any focused button made clicking Next and then pressing Space press Next
 * again - the song skipped instead of pausing, which is the one thing every
 * media app does with Space. The question that separates the two is "did
 * this focus arrive by keyboard", and `:focus-visible` looks like the
 * browser's own answer to it, but it is not one that can be trusted here:
 * measured in Chromium, a button clicked with the mouse matches it. So the
 * app keeps its own answer, the way focus-visible polyfills always have: a
 * pointer going down means the next Space is the music's; Tab means focus is
 * being walked by keyboard, and a control reached that way keeps its Space.
 *
 * Captured on `window` so nothing that stops propagation can hide either one.
 */
let walkedByKeyboard = false;
if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => {
    walkedByKeyboard = false;
  }, true);
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Tab') walkedByKeyboard = true;
  }, true);
}

function keyboardFocused(): boolean {
  return walkedByKeyboard;
}

/**
 * Is a kit overlay standing - a modal, a menu, a palette?
 *
 * Those close themselves on Escape (the kit binds it on `document` and does
 * not stop the event), so an Escape action that also ran would close TWO
 * things: the kit's popover and the sheet under it. The kit marks every
 * modal `aria-modal="true"` and every menu `role="menu"`, which is a cheaper
 * question than trying to follow focus.
 */
export function kitOverlayOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector('[aria-modal="true"], [role="menu"], [role="listbox"]') !== null;
}
