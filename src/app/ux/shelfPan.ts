/**
 * Both axes on a shelf, at last.
 *
 * `touch-action` on a horizontal shelf inside a vertical page is a seesaw, and
 * this app has sat on both ends of it. `pan-x` gives the shelf its sideways
 * drags but DISCARDS a vertical one that starts on a shelf, so a page of
 * shelves becomes a page of dead zones. `pan-x pan-y` lets the engine choose,
 * and the engine gives the ambiguous middle to the page - which is the "very
 * hard to swipe sideways" complaint the `pan-x` existed to answer.
 *
 * There is no third value. The only way off is to stop letting the engine
 * decide, so:
 *
 *   VERTICAL stays native. `touch-action: pan-y` means a downward drag that
 *   begins anywhere on a shelf is an ordinary page scroll, with the OS's own
 *   momentum, rubber-band and overscroll chaining. That is the app's primary
 *   gesture and hand-rolling it would be a downgrade nobody asked for.
 *
 *   HORIZONTAL is ours. Under `pan-y` the engine will not pan sideways at all,
 *   so a sideways drag arrives here as plain touch events and we move
 *   scrollLeft ourselves, with a flick that carries on afterwards.
 *
 * Delegated from the document rather than wired per shelf: six surfaces draw
 * shelves today and the next one should not have to remember. One listener
 * set, and any element matching SHELF finds itself scrollable.
 */

/** The ScrollArea viewport inside a horizontal shelf - the element that
 *  actually scrolls. Matches app.css's own rule. */
const SHELF = '.homeShelfScroll [data-scrollbar-appearance]';

/**
 * How far a finger travels before the gesture is judged.
 *
 * Small enough that the shelf answers promptly, large enough that the angle is
 * real: at three or four pixels every drag is diagonal and the axis is a coin
 * toss. Below this nothing is claimed and a tap is still a tap.
 */
const SLOP = 10;

/** Flick decay per frame, and the speed below which it has stopped. Tuned to
 *  land close to the platform's own feel: a hard flick crosses about a screen
 *  and a half, a gentle one glides to a stop. */
const FRICTION = 0.94;
const STILL = 0.02;

export function installShelfPan(): () => void {
  let shelf: HTMLElement | null = null;
  let touchId: number | null = null;
  let startX = 0;
  let startY = 0;
  let startLeft = 0;
  /** null while undecided; 'x' once ours; the tracking stops dead on 'y'. */
  let axis: 'x' | 'y' | null = null;
  /** Finger speed in px/ms, from the last two samples - recent, so the flick
   *  reflects how the gesture ENDED rather than its average. */
  let velocity = 0;
  let lastX = 0;
  let lastAt = 0;
  let glide = 0;

  const stopGlide = () => {
    if (glide) cancelAnimationFrame(glide);
    glide = 0;
  };

  const clamp = (el: HTMLElement, left: number) =>
    Math.max(0, Math.min(left, el.scrollWidth - el.clientWidth));

  const onStart = (event: TouchEvent) => {
    // A second finger means a pinch or a two-finger gesture; neither is ours.
    if (event.touches.length !== 1) return;
    const touch = event.touches[0]!;
    const found = (touch.target as HTMLElement | null)?.closest?.(SHELF);
    if (!(found instanceof HTMLElement)) return;
    // Landing on a gliding shelf catches it, the way a finger on a spinning
    // record stops it.
    stopGlide();
    shelf = found;
    touchId = touch.identifier;
    startX = touch.clientX;
    startY = touch.clientY;
    startLeft = found.scrollLeft;
    axis = null;
    velocity = 0;
    lastX = touch.clientX;
    lastAt = event.timeStamp;
  };

  const onMove = (event: TouchEvent) => {
    if (!shelf || touchId === null) return;
    const touch = Array.from(event.touches).find((t) => t.identifier === touchId);
    if (!touch) return;

    const dx = touch.clientX - startX;
    const dy = touch.clientY - startY;

    if (axis === null) {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (axis === 'y') {
        // The engine's, and it already has it: `pan-y` let it start scrolling
        // the page the moment the finger moved. Let go entirely.
        shelf = null;
        touchId = null;
        return;
      }
    }

    // Ours. preventDefault stops the engine starting a vertical pan off the
    // gesture's drift - without it a mostly-sideways drag creeps the page.
    if (event.cancelable) event.preventDefault();
    shelf.scrollLeft = clamp(shelf, startLeft - dx);

    const dt = event.timeStamp - lastAt;
    if (dt > 0) {
      // Blended with the previous reading so one jittery sample cannot throw
      // the flick, while a genuine change in speed still lands quickly.
      velocity = 0.7 * ((touch.clientX - lastX) / dt) + 0.3 * velocity;
      lastX = touch.clientX;
      lastAt = event.timeStamp;
    }
  };

  const onEnd = () => {
    const el = shelf;
    shelf = null;
    touchId = null;
    if (!el || axis !== 'x') return;
    axis = null;

    // The finger moves one way, the content the other.
    let speed = -velocity;
    if (Math.abs(speed) < STILL) return;

    let previous = performance.now();
    const step = (now: number) => {
      // Frame-time scaled so a dropped frame does not shorten the glide.
      const frames = Math.max(0.5, Math.min(3, (now - previous) / 16.67));
      previous = now;
      speed *= Math.pow(FRICTION, frames);
      const next = clamp(el, el.scrollLeft + speed * 16.67 * frames);
      // Hitting an end stops it: no rubber-band here, because the engine is
      // not the one moving this and a fake bounce reads as a stutter.
      if (next === el.scrollLeft || Math.abs(speed) < STILL) {
        glide = 0;
        return;
      }
      el.scrollLeft = next;
      glide = requestAnimationFrame(step);
    };
    glide = requestAnimationFrame(step);
  };

  // Move must be non-passive: preventDefault is what keeps the page still
  // while a sideways drag runs.
  document.addEventListener('touchstart', onStart, { passive: true });
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('touchend', onEnd, { passive: true });
  document.addEventListener('touchcancel', onEnd, { passive: true });

  return () => {
    stopGlide();
    document.removeEventListener('touchstart', onStart);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
    document.removeEventListener('touchcancel', onEnd);
  };
}
