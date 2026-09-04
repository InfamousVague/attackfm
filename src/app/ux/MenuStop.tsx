import type { ReactNode } from 'react';

/**
 * A menu's panel, kept from reaching whatever the menu is worn on.
 *
 * A ContextMenu's panel is PORTALLED - it is nowhere near the row in the DOM -
 * and that is exactly what makes this necessary rather than obvious. React
 * propagates a portal's events through the COMPONENT tree, not the DOM tree,
 * so a click on a menu item arrives at the row's own `onClick` as though it
 * had happened on the row. Measured, not reasoned: the row's React handler
 * fires while a capture listener on the row's DOM node sees nothing at all.
 *
 * On a phone this was invisible. The long-press that opens the menu arms
 * `useHoldToMenu`'s click swallow, and the swallow ate the fall-through as a
 * side effect of the job it was written for. A right-click opens the same menu
 * with nothing armed - so on the desktop, choosing "Add to queue" also
 * activated the row underneath it, and the song you meant to queue started
 * playing instead.
 *
 * `display: contents` so the panel's own layout is untouched: this adds a
 * component to the tree and no box to the page. The stop is on the BUBBLE
 * phase deliberately - the item's own handler has to run first, and a capture
 * stop here would swallow the very selection it is protecting.
 */
export function MenuStop({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: 'contents' }} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}
