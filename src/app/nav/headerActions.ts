import type { ComponentType } from 'react';
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
  /**
   * A thumbnail to sit before the name: the album mosaic of a playlist, the
   * artist's portrait, the mark a collection wears. Absent where the page has
   * no single honest image for itself - the empty-state art is painted onto
   * the page background, so it reads as a smudge at this size.
   */
  art?: string | null;
  /** Round for a person, square for a record. */
  artRound?: boolean;
  /**
   * A kit glyph instead of a thumbnail, for a page whose mark is a GRAPHIC
   * rather than a photograph of music.
   *
   * A record sleeve, an artist's portrait and a playlist's mosaic all survive
   * being shrunk to this size, because they are pictures of something and the
   * something is still legible. A rendered object is not: the Liked valve at
   * twenty-odd pixels is an orange-pink blob, and the row reads as a picture
   * failing to load rather than as an emblem. A line drawing is built for this
   * size and says the same word.
   *
   * Passed as the component, not an element: this rides in a store the header
   * compares by identity, and fresh JSX on every render would be a new value
   * every time. A module-level icon is stable.
   */
  glyph?: ComponentType<{ size?: number }> | null;
  /**
   * Optional, because not every page that wants its NAME up here has a single
   * thing to play. A shelf of audiobooks is a place, not a collection: Play
   * and Shuffle over it would have to pick a book, and picking one is the
   * question the page exists to ask. Absent means the controls simply are not
   * drawn, rather than drawn dead.
   */
  play?: () => void;
  shuffle?: () => void;
  /** Nothing to play - both controls draw, both are dead. */
  disabled?: boolean;
  /**
   * One page-specific control to sit where Play would.
   *
   * Described rather than handed over as JSX, for the same reason `glyph` is a
   * component and not an element: this rides in a store compared by identity,
   * and fresh markup on every render would publish a new value every time.
   */
  action?: {
    icon: ComponentType<{ size?: number }>;
    /** For the screen reader, and the tooltip. */
    label: string;
    onPress: () => void;
  } | null;
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
