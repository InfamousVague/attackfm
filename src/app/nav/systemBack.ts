//! The system back gesture, answered by the app.
//!
//! On Android the OS owns the back swipe; the native side (MainActivity.kt)
//! catches it and asks this module whether the app can use it. The answer is a
//! walk down a stack of handlers, newest first - an open sheet or modal
//! registers one while it is up, the nav stack in App holds the bottom one -
//! and the first handler to consume the gesture wins. Nothing consumed it
//! means the app is at its root, and native backgrounds the task (the gesture
//! must always DO something; swallowing it at the root would trap the user).
//!
//! Handlers are functions returning true when they consumed the back. They
//! stack in the order they register, which - since overlays register when they
//! OPEN, not when they mount - is opening order: the newest thing on screen is
//! the first thing a back swipe dismisses, exactly the order a person expects.

import { useEffect, useRef } from 'react';

type BackHandler = () => boolean;

const handlers: BackHandler[] = [];

/** Register a back handler on top of the stack; returns its unregister. */
export function onSystemBack(handler: BackHandler): () => void {
  handlers.push(handler);
  return () => {
    const at = handlers.indexOf(handler);
    if (at !== -1) handlers.splice(at, 1);
  };
}

/** While `active`, a back gesture runs `close` (and is consumed). The overlay
 *  case in one line: pass the open flag and the closer. */
export function useSystemBack(active: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!active) return;
    return onSystemBack(() => {
      closeRef.current();
      return true;
    });
  }, [active]);
}

declare global {
  interface Window {
    /** Called by Android's MainActivity on a back gesture. True = consumed. */
    __AFM_BACK__?: () => boolean;
  }
}

// Installed unconditionally at import: only Android's native shell ever calls
// it, so on every other platform this is one inert property.
if (typeof window !== 'undefined') {
  window.__AFM_BACK__ = () => {
    for (let i = handlers.length - 1; i >= 0; i--) {
      const handler = handlers[i];
      if (handler && handler()) return true;
    }
    return false;
  };
}
