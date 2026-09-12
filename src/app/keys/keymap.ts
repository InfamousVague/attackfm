/**
 * Which chord each action answers to, and where that is kept.
 *
 * Only the CHANGES are stored: `attackfm-keymap` is a JSON object of
 * `actionId -> chord` for the actions somebody has rebound, with `null` for
 * one they have switched off altogether. An action not in the object is on
 * its shipped chord, which means a default that changes in a later build
 * reaches everyone who never touched that row - the same reasoning
 * behaviourPrefs gives for storing only the side that differs.
 *
 * The key is in prefsSync's SYNCED_KEYS: a keymap is a habit of the hands,
 * not a fact about the machine, and it is spelled with `mod` rather than ⌘ or
 * Ctrl precisely so it can land on either kind of machine unchanged. A sync
 * arrives as a `storage` event (prefsSync dispatches one for the tab that
 * did the write), which is why this store listens for it.
 *
 * A live store - module listeners plus useSyncExternalStore, the shape
 * developerMode.ts uses - because the settings pane edits it while the
 * listener that reads it is already installed, and a listener that only
 * re-read on mount would keep answering to the old keys until a reload.
 */
import { useSyncExternalStore } from 'react';
import { KEY_ACTIONS, type KeyActionId } from './actions.ts';
import { formatChord, parseChord } from './chords.ts';

export const KEYMAP_KEY = 'attackfm-keymap';

/** The chord each action currently answers to; null is switched off. */
export type Keymap = Readonly<Record<KeyActionId, string | null>>;

type Overrides = Partial<Record<KeyActionId, string | null>>;

const listeners = new Set<() => void>();
const ids = new Set<string>(KEY_ACTIONS.map((a) => a.id));

/**
 * The stored changes, each one checked on its own: a chord that no longer
 * parses, or an id from an action that no longer exists, is dropped rather
 * than allowed to take the rest down with it.
 */
function readOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(KEYMAP_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Overrides = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!ids.has(id)) continue;
      if (value === null) out[id as KeyActionId] = null;
      else if (typeof value === 'string') {
        const chord = parseChord(value);
        if (chord) out[id as KeyActionId] = formatChord(chord);
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeOverrides(next: Overrides): void {
  try {
    if (Object.keys(next).length === 0) localStorage.removeItem(KEYMAP_KEY);
    else localStorage.setItem(KEYMAP_KEY, JSON.stringify(next));
  } catch {
    // Storage refused: the binding holds for this run and not beyond it.
  }
}

function build(overrides: Overrides): Keymap {
  const map = {} as Record<KeyActionId, string | null>;
  for (const action of KEY_ACTIONS) {
    map[action.id] = action.id in overrides ? (overrides[action.id] ?? null) : action.chord;
  }
  return map;
}

/*
 * One snapshot object per change. useSyncExternalStore compares snapshots by
 * identity, so a getter that rebuilt the object on every call would re-render
 * every subscriber on every render, forever.
 */
let snapshot: Keymap = build(readOverrides());

function notify(): void {
  snapshot = build(readOverrides());
  for (const fn of listeners) fn();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === KEYMAP_KEY || event.key === null) notify();
  });
}

/** The keymap as it stands. */
export function keymap(): Keymap {
  return snapshot;
}

/** The chord an action answers to right now, or null when switched off. */
export function chordFor(id: KeyActionId): string | null {
  return snapshot[id];
}

/**
 * Bind an action to a chord, or to nothing (`null` switches it off). The
 * chord is re-spelled canonically on the way in so `shift+mod+S` and
 * `mod+shift+S` cannot become two bindings that look different and press
 * the same key.
 */
export function setBinding(id: KeyActionId, chord: string | null): void {
  const next = { ...readOverrides() };
  if (chord === null) {
    next[id] = null;
  } else {
    const parsed = parseChord(chord);
    if (!parsed) return;
    const spelled = formatChord(parsed);
    const shipped = KEY_ACTIONS.find((a) => a.id === id)?.chord;
    // Rebinding to the shipped chord is a reset, and is stored as one.
    if (spelled === shipped) delete next[id];
    else next[id] = spelled;
  }
  writeOverrides(next);
  notify();
}

/** Back to the shipped chord for one action. */
export function resetBinding(id: KeyActionId): void {
  const next = { ...readOverrides() };
  if (!(id in next)) return;
  delete next[id];
  writeOverrides(next);
  notify();
}

/** Back to the shipped chords for every action. */
export function resetAllBindings(): void {
  writeOverrides({});
  notify();
}

/** Is this action on the chord it shipped with? */
export function isShippedBinding(id: KeyActionId, map: Keymap = snapshot): boolean {
  return map[id] === (KEY_ACTIONS.find((a) => a.id === id)?.chord ?? null);
}

/** How many actions are off their shipped chord. */
export function customBindingCount(map: Keymap = snapshot): number {
  return KEY_ACTIONS.filter((a) => map[a.id] !== a.chord).length;
}

/**
 * Every action whose chord another action also claims, each listed with the
 * others on the same chord. Two actions on one chord is not refused - the
 * pane says so beside both rows and lets the person sort it out - but the
 * listener runs only the first in catalogue order, so the warning is the
 * whole of what stops the second from silently doing nothing.
 */
export function bindingConflicts(map: Keymap = snapshot): Map<KeyActionId, KeyActionId[]> {
  const byChord = new Map<string, KeyActionId[]>();
  for (const action of KEY_ACTIONS) {
    const chord = map[action.id];
    if (!chord) continue;
    const list = byChord.get(chord) ?? [];
    list.push(action.id);
    byChord.set(chord, list);
  }
  const out = new Map<KeyActionId, KeyActionId[]>();
  for (const list of byChord.values()) {
    if (list.length < 2) continue;
    for (const id of list) out.set(id, list.filter((other) => other !== id));
  }
  return out;
}

/** The action a chord is bound to, first in catalogue order, or null. */
export function actionForChord(chord: string, map: Keymap = snapshot): KeyActionId | null {
  for (const action of KEY_ACTIONS) if (map[action.id] === chord) return action.id;
  return null;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The keymap, live across every component that reads it. */
export function useKeymap(): Keymap {
  return useSyncExternalStore(subscribe, keymap, keymap);
}
