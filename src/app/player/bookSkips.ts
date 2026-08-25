/**
 * Which readings should open past the publisher's card.
 *
 * PER TRACK, though the listener chooses per BOOK. Those are the same decision
 * seen from two ends: the shelf knows what a book is and toggles all of its
 * files at once, while playback only ever holds one track and needs the answer
 * without knowing which book it belongs to. Keying by track id is what lets
 * the second one be a synchronous lookup with no fetch and no shelf in scope.
 *
 * It also happens to be right for how these recordings are actually made: a
 * LibriVox book split into sections repeats its preamble at the START of every
 * section and its sign-off at the END of every one, so "skip the card" is a
 * per-file behaviour, not something that only applies to the first file.
 *
 * A device preference, like the other playback switches. It is a listening
 * habit rather than a fact about the library - somebody else on the same
 * server may well want the credits - so it does not belong in the shared
 * database, and the marks it acts on are the only part that does.
 */

const KEY = 'attackfm-book-skips';

let ids: Set<number> | null = null;
const listeners = new Set<() => void>();

function load(): Set<number> {
  if (ids) return ids;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    ids = new Set(Array.isArray(parsed) ? parsed.filter((n): n is number => typeof n === 'number') : []);
  } catch {
    ids = new Set();
  }
  return ids;
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify([...load()]));
  } catch {
    /* A full store costs the setting, nothing else. */
  }
  for (const fn of listeners) fn();
}

/** Should this track open past its card and stop before its credits? */
export function skipsCard(trackId: number | null): boolean {
  if (trackId === null) return false;
  return load().has(trackId);
}

/** Turn it on or off for every file of one book at once. */
export function setSkipsCard(trackIds: number[], on: boolean): void {
  const set = load();
  for (const id of trackIds) {
    if (on) set.add(id);
    else set.delete(id);
  }
  save();
}

/** True when every one of a book's files is set to skip. */
export function bookSkips(trackIds: number[]): boolean {
  if (trackIds.length === 0) return false;
  const set = load();
  return trackIds.every((id) => set.has(id));
}

export function watchSkips(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
