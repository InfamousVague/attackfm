/**
 * Keeps a popover from closing when you touch a menu it opened.
 *
 * The kit's Select portals its listbox to document.body with fixed positioning,
 * so it escapes clipping and stacking contexts - which is right, and which also
 * makes it a SIBLING of the popover that contains the trigger rather than a
 * descendant of it. The kit's Popover dismisses on any pointerdown whose target
 * is inside neither its positioner nor its trigger, and a portaled listbox is
 * inside neither. So the press that opens the dropdown, or the one that starts
 * a scroll through it, reads as a press outside the panel and shuts it.
 *
 * That is what closed the equalizer when you scrolled its preset list.
 *
 * The fix is to stop the event on its way UP, at the body, so it never reaches
 * the document listener that does the dismissing. Bubble phase on the body is
 * exactly the right seam: the listbox's own handlers sit at or below it and
 * have already run, so selection, keyboard and scrolling all still work - only
 * the dismissal upstairs is denied. A capture-phase listener would be wrong; it
 * would run before the listbox and eat its own clicks.
 *
 * Deliberately narrow: only a real listbox or menu counts, so ordinary
 * outside-presses still dismiss everything the way they should.
 */
const OVERLAY = '[role="listbox"], [role="menu"], [role="menuitem"], [role="option"]';

export function installOverlayGuard(): () => void {
  const onPointerDown = (e: PointerEvent) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest(OVERLAY)) e.stopPropagation();
  };
  document.body.addEventListener('pointerdown', onPointerDown);
  return () => document.body.removeEventListener('pointerdown', onPointerDown);
}
