import { useEffect } from 'react';

/**
 * Keeps the app's decorative looping clips moving.
 *
 * Inline video is paused for you whenever the page stops being visible - a tab
 * in the background, the app switcher, a locked phone - and nothing starts it
 * again. `loop` is no help: it fires at the END of a clip, and a clip paused
 * two seconds in never reaches one. So a Canvas wall that was drifting before
 * you took a call is a still photograph after it, for the rest of the session.
 *
 * One listener for the whole app rather than one per clip: a wall is a dozen
 * videos and the artist hero is several more, and they all want the same nudge
 * at the same moment. Clips opt in by carrying `data-loop-art`.
 *
 * Every `play()` is caught and dropped. A browser refusing to autoplay is an
 * answer, not an error, and a wall that will not move is not worth a console
 * full of rejections.
 */
const SELECTOR = 'video[data-loop-art]';

let wired = false;

function resumeAll(): void {
  if (document.hidden) return;
  document.querySelectorAll<HTMLVideoElement>(SELECTOR).forEach((v) => {
    if (v.paused) void v.play().catch(() => {});
  });
}

function wire(): void {
  if (wired) return;
  wired = true;
  document.addEventListener('visibilitychange', resumeAll);
  // Coming back through the bfcache does not raise visibilitychange on every
  // engine, and it is exactly the "switched away and back" case this is for.
  window.addEventListener('pageshow', resumeAll);
}

/** Call from any component that renders looping clip art. Idempotent - the
 *  listeners are wired once for the app, not once per clip. */
export function useLoopArt(): void {
  useEffect(() => {
    wire();
    // A clip mounted into an already-visible page whose autoplay was refused
    // (or which mounted while hidden and is now shown) gets one nudge here.
    resumeAll();
  }, []);
}
