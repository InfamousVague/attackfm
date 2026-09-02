import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useSystemBack } from '../nav/systemBack.ts';

/**
 * The app's own sheet - the search summon's material, made reusable.
 *
 * A fixed panel from the header's line down, so the ATTACK mark keeps
 * peeking above it and the thing reads as dismissable; the nav bar's glass
 * recipe (thick, blur-lg, saturate) so it is the same material as the other
 * floating chrome; rounded shoulders, a hairline, and a handle pill that says
 * "pull me". And it can be pulled: a downward drag rides the finger and lets
 * go past the mark, or springs home short of it - the same leaving the Now
 * Playing sheet and the summon do, so every sheet in the app dismisses the
 * same way. Escape, the scrim, the handle and the system back all close it too.
 *
 * Used where the kit's Drawer was: that one is a fine generic drawer, and
 * exactly what got reported - "not the same glass sheet search uses".
 */

/** How far a pull has to travel before letting go counts as dismissing. */
const LET_GO_PX = 110;
/** A quick flick dismisses short of the mark. px/ms. */
const FLICK = 0.6;

export function GlassSheet({
  open,
  onClose,
  label,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const sheet = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState(0);
  const dragRef = useRef(0);
  const start = useRef<{ y: number; t: number; on: boolean } | null>(null);
  useSystemBack(open, onClose);

  /*
   * Why the pull needs a native touchmove listener as well as pointer events.
   *
   * On a phone the sheet's body scrolls, so the browser treats a vertical
   * finger as a candidate scroll. The moment it decides that is what it is -
   * a few pixels in - it takes the gesture for itself and fires pointercancel,
   * and the pull above stops at nothing: the sheet twitched a few pixels and
   * sprang back, which read as "you can't swipe to close". The only way to
   * keep the gesture is to preventDefault the touchmove while it is a pull
   * (content at its top, finger going down), and React's own onTouchMove is
   * passive since 17, so preventDefault there is ignored - hence a listener
   * attached by hand with passive: false. Upward moves after a pull has
   * begun are prevented too, so a finger that wavers cannot hand the sheet
   * to the scroller mid-gesture.
   */
  useEffect(() => {
    const el = sheet.current;
    if (!open || !el) return;
    const onTouchMove = (e: TouchEvent) => {
      const s = start.current;
      const touch = e.touches[0];
      if (!s || !s.on || !touch) return;
      const dy = touch.clientY - s.y;
      if (dy > 0 || dragRef.current > 0) e.preventDefault();
    };
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onTouchMove);
  }, [open]);

  // Escape, like every dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Fresh each open: a sheet that closed mid-drag must not reopen displaced.
  useEffect(() => {
    if (!open) {
      setDrag(0);
      dragRef.current = 0;
    }
  }, [open]);

  if (!open) return null;

  /*
   * The pull. Pointer events so mouse and touch share one path; only a
   * DOWNWARD drag is a pull (upward is the content scrolling), and only when
   * the content is at its top - a list scrolled halfway must keep scrolling.
   */
  const onPointerDown = (e: React.PointerEvent) => {
    const scroller = (e.target as HTMLElement).closest('[data-sheet-scroll]');
    const atTop = !scroller || scroller.scrollTop <= 0;
    start.current = { y: e.clientY, t: performance.now(), on: atTop };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const s = start.current;
    if (!s || !s.on) return;
    const dy = Math.max(0, e.clientY - s.y);
    dragRef.current = dy;
    setDrag(dy);
    if (dy > 0) sheet.current?.setAttribute('data-dragging', '');
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const s = start.current;
    start.current = null;
    sheet.current?.removeAttribute('data-dragging');
    if (!s || !s.on) return;
    // A cancel (the browser took the gesture after all) still judges by how
    // far the sheet had come, not by a clientY the cancel may not carry.
    const dy = e.type === 'pointercancel' ? dragRef.current : e.clientY - s.y;
    const v = dy / Math.max(1, performance.now() - s.t);
    dragRef.current = 0;
    if (dy > LET_GO_PX || (dy > 24 && v > FLICK)) onClose();
    else setDrag(0);
  };

  return createPortal(
    <>
      <div className="glassSheet__scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheet}
        className={`glassSheet${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        style={{ ['--sheet-drag' as string]: `${drag}px` }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <button type="button" className="glassSheet__handle" aria-label="Close" onClick={onClose}>
          <span aria-hidden="true" />
        </button>
        <div className="glassSheet__body" data-sheet-scroll>
          {children}
        </div>
      </div>
    </>,
    document.body,
  );
}
