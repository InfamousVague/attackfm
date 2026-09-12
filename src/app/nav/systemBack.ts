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
/**
 * The handlers that are SHEETS - registered through `useSystemBack` while
 * something is open over the page - as opposed to the nav stack's own, which
 * walks page history. The Escape key (keys/actions.ts) wants the first kind
 * and never the second: Escape puts down what is on top, it does not go back
 * a page.
 */
const overlays = new WeakSet<BackHandler>();

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
    const handler: BackHandler = () => {
      closeRef.current();
      return true;
    };
    overlays.add(handler);
    return onSystemBack(handler);
  }, [active]);
}

/**
 * Put down the top sheet, if there is one: the newest overlay on the stack,
 * skipping the nav handler underneath. True when something closed. This is
 * what the Escape key does when no kit modal is holding it.
 */
export function closeTopOverlay(): boolean {
  for (let i = handlers.length - 1; i >= 0; i--) {
    const handler = handlers[i];
    if (handler && overlays.has(handler)) return handler();
  }
  return false;
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
