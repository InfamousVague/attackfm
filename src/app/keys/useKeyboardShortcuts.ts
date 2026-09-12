/**
 * The one keydown listener.
 *
 * Installed once, at app level, for the life of the app. It reads the keymap
 * store rather than holding a copy, so a row rebound in Settings answers to
 * its new key on the next press with nothing remounted; and it reaches the
 * deck through keys/deckDoor.ts, so it is inert - a chord lookup and a null
 * check - until a Player is standing.
 *
 * Every press is turned away before any chord is looked up when:
 *   - something already spent it (`defaultPrevented`): a kit menu, the
 *     handbook's page turn, the search page's own ⌘K;
 *   - the target is a place a person types (keys/guard.ts);
 *   - it is an IME composition, where `key` is not a key at all;
 *   - the key is held and the action is not one that repeats.
 * And a plain-key chord yields to a focused control that consumes that key
 * natively - Space on a switch, an arrow on a tab strip - so a person working
 * the app by keyboard is never surprised by the music.
 *
 * On `window`, bubbling, not capturing: anything that stops propagation on
 * the way up (the kit's menus and palettes do) has thereby said the press
 * was its own, and this listener should never hear it.
 */
import { useEffect, useRef } from 'react';
import { KEY_ACTIONS, type KeyActionDeps } from './actions.ts';
import { chordFromEvent, formatChord } from './chords.ts';
import { isEditableTarget, kitOverlayOpen, nativelyConsumed } from './guard.ts';
import { actionForChord } from './keymap.ts';

/**
 * The listener's body, separated from the hook so a test can feed it events
 * without a React tree. True when the press was spent.
 */
export function handleKeyEvent(event: KeyboardEvent, deps: KeyActionDeps): boolean {
  if (event.defaultPrevented || event.isComposing) return false;
  if (isEditableTarget(event.target)) return false;
  const chord = chordFromEvent(event);
  if (!chord) return false;
  const id = actionForChord(formatChord(chord));
  if (!id) return false;
  const action = KEY_ACTIONS.find((a) => a.id === id);
  if (!action) return false;
  if (event.repeat && !action.repeats) {
    // Held, and not a nudge: the first press did the work. Still spent, or
    // a held Space would scroll the page on its second repeat.
    event.preventDefault();
    return true;
  }
  if (!chord.mod && !chord.alt && nativelyConsumed(event.target, chord.key)) return false;
  // Escape belongs to the kit while one of its overlays is up.
  if (action.id === 'close' && kitOverlayOpen()) return false;
  if (!action.run(deps)) return false;
  event.preventDefault();
  return true;
}

export function useKeyboardShortcuts(deps: KeyActionDeps): void {
  // Read through a ref so a changing door never re-binds the listener.
  const depsRef = useRef(deps);
  depsRef.current = deps;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      handleKeyEvent(event, depsRef.current);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
