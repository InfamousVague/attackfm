import { useSyncExternalStore } from 'react';

/**
 * What the page below has lent the app header: its name, and its controls.
 *
 * The header (App.tsx, .mobileHeader) is a sibling of the page stack, not an
 * ancestor of it, so a page that wants to put something up there has no props
 * to pass and no context to reach for without threading a provider around half
 * of App.tsx. This is that channel: the page says what it wants done, the
 * header draws the controls and owns their look.
 *
 * Intent, not markup. Handing over a ReactNode would let a page smuggle its own
 * styling into the header and would re-publish on every render (fresh JSX each
 * time), where a plain object with stable callbacks settles.
 *
 * A module singleton rather than a context because there is exactly one header
 * for the app's whole life, and the alternative - looking the node up with
 * querySelector and portalling into it - is quietly broken: the node captured
 * at mount is detached the moment the header remounts, and the controls
 * disappear into an orphan with nothing on screen to show for it.
 */
export interface HeaderActions {
  /**
   * What the page is called, shown where the wordmark otherwise sits. The page
   * that lends its controls lends its NAME with them: once its own header has
   * scrolled away, the app's logo is the least useful thing that row could be
   * holding, and a collection with Play in the corner and no name attached
   * leaves you asking play WHAT.
   */
  title: string;
  play: () => void;
  shuffle: () => void;
  /** Nothing to play - both controls draw, both are dead. */
  disabled: boolean;
}

let current: HeaderActions | null = null;
const listeners = new Set<() => void>();

/**
 * Publish (or, with null, withdraw) the header's actions.
 *
 * Call from an effect and withdraw on cleanup, so a page that unmounts - or
 * scrolls back to where its own controls are on screen - does not leave a live
 * Play button pointing at a list nobody is looking at.
 */
export function setHeaderActions(next: HeaderActions | null): void {
  if (current === next) return;
  current = next;
  for (const listen of listeners) listen();
}

/** What the header should draw. Null while no page is asking for anything. */
export function useHeaderActions(): HeaderActions | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
    // The server never renders this shell, but getServerSnapshot is required
    // and must not return a fresh value.
    () => null,
  );
}
