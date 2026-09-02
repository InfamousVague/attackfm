import { useEffect, useRef, useSyncExternalStore } from 'react';

/**
 * What the header's share button DOES right now.
 *
 * The button lives in the app header, at the bell's right hand, and the
 * header is a sibling of the page stack - so a page that wants that button
 * to mean "share THIS" has no props to reach it with. Same answer as
 * headerActions.ts: a module singleton the page publishes into and the
 * button reads from. Unlike headerActions this is not tied to the page's own
 * controls scrolling away - a playlist is shareable the whole time you are
 * on it - so a page claims the door for as long as it is mounted.
 *
 * With nobody claiming it, the button is the invite card: how to get a
 * friend onto this server. With a page claiming it, the button is that
 * page's share - a playlist's seats, say - and wears that page's label.
 */
export interface ShareDoor {
  /** For the screen reader and the tooltip: "Share this playlist". */
  label: string;
  open: () => void;
}

let current: ShareDoor | null = null;
const listeners = new Set<() => void>();

function publish(next: ShareDoor | null): void {
  if (current === next) return;
  current = next;
  for (const listen of listeners) listen();
}

/** The door the header should open. Null means the invite card. */
export function useShareDoor(): ShareDoor | null {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => current,
    () => null,
  );
}

/**
 * Claim the header's share button while this page is mounted - or, with
 * null, leave it to the invite card. Safe to call with a fresh object every
 * render: the published door is a stable shell whose `open` always calls
 * the latest callback, so the header only re-renders when the label changes
 * or the claim comes and goes.
 */
export function useOfferShare(door: ShareDoor | null): void {
  const latest = useRef(door);
  latest.current = door;
  const label = door?.label ?? null;
  useEffect(() => {
    if (label === null) return;
    const shell: ShareDoor = { label, open: () => latest.current?.open() };
    publish(shell);
    return () => {
      // Only let go of what is still ours: a page that mounted after us has
      // already replaced the door, and must keep it.
      if (current === shell) publish(null);
    };
  }, [label]);
}
