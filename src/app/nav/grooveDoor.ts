/**
 * The door onto the groove DECK - the popover behind the Users glyph.
 *
 * Unlike the other doors this one is not an opener somebody registers: the
 * deck is a controlled Popover that mounts with the surface it sits in (the
 * Now Playing sheet's action row, the desktop strip's rail), and at the
 * moment a join lands that surface may not exist yet. So the provider ARMS
 * the door and whichever deck is standing - or the next one to mount -
 * takes the arm and opens itself.
 *
 * The arm EXPIRES. Five seconds is long enough for the sheet to lift and the
 * deck inside it to mount, and short enough that an arm nobody took (a join
 * on a shape with no deck to open) cannot pop the panel when a deck mounts
 * for some unrelated reason a minute later. Taking the arm clears it, so two
 * decks standing at once open one panel, not two.
 */
let armedAt = 0;
const ARM_MS = 5000;
const listeners = new Set<() => void>();

export function armGrooveDeck(): void {
  armedAt = Date.now();
  for (const fn of listeners) fn();
}

/** Take the arm if it is live. Clears it either way. */
export function takeGrooveArm(): boolean {
  const live = armedAt > 0 && Date.now() - armedAt < ARM_MS;
  armedAt = 0;
  return live;
}

/** Be told when the door is armed while this deck is already standing. */
export function onGrooveArm(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
