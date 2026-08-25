/*
 * Places in a book somebody meant to keep.
 *
 * NOT the same thing as the resume mark, and the difference is the whole point.
 * The resume mark is written FOR you every twenty seconds and there is exactly
 * one per section - it answers "where did I stop". A bookmark is dropped BY you
 * and there can be as many as you like - it answers "the bit I want to find
 * again": the passage worth re-reading, the place an argument starts, where you
 * were when somebody interrupted.
 *
 * WHY THESE LIVE IN PREFS. They are person-level, not device-level - a place
 * you kept on the sofa should be there on the bus - and `prefsSync` already
 * carries exactly that sort of thing between devices without the music server
 * needing to know (`attackfm-handbook-page`, your place in the manual, is the
 * closest existing relative). Keeping them here means no hub change and no
 * migration, and a bookmark survives switching servers because each one records
 * the server it belongs to.
 */

const KEY = 'attackfm-book-bookmarks';

/** Fired when the set changes, so open surfaces redraw without polling. */
export const BOOKMARKS_CHANGED = 'attackfm:bookmarks-changed';

export interface Bookmark {
  /** Which library this belongs to - track ids are only unique within one. */
  server: string;
  trackId: number;
  positionMs: number;
  /** What was playing there: the chapter's name, so a list reads as places. */
  label: string;
  /**
   * The sentence being read at that moment, where the words are known.
   *
   * A list of "Chapter 7, Chapter 7, Chapter 7" is ten identical rows for ten
   * different places - the chapter is where the bookmark IS, not what it
   * kept. The line is the thing somebody actually meant to hold on to, and
   * the transcript already knows it, so keeping it costs one lookup.
   */
  quote?: string;
  /** When it was dropped, for ordering and for de-duplicating a double tap. */
  at: number;
}

function read(): Bookmark[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Written by another version, or by a hand: keep only what is usable rather
    // than throwing the whole list away over one bad row.
    return parsed.filter(
      (b): b is Bookmark =>
        !!b &&
        typeof b === 'object' &&
        typeof (b as Bookmark).server === 'string' &&
        typeof (b as Bookmark).trackId === 'number' &&
        typeof (b as Bookmark).positionMs === 'number',
    );
  } catch {
    return [];
  }
}

function write(list: Bookmark[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // A full quota is not worth an exception into a tap handler.
  }
  window.dispatchEvent(new Event(BOOKMARKS_CHANGED));
}

/** Every bookmark in one book, earliest place first - a list of PLACES, so it
 *  reads in the order you would meet them, not the order they were dropped. */
export function bookmarksIn(server: string, trackIds: readonly number[]): Bookmark[] {
  const wanted = new Set(trackIds);
  const order = new Map(trackIds.map((id, i) => [id, i]));
  return read()
    .filter((b) => b.server === server && wanted.has(b.trackId))
    .sort(
      (x, y) =>
        (order.get(x.trackId) ?? 0) - (order.get(y.trackId) ?? 0) || x.positionMs - y.positionMs,
    );
}

/**
 * How close two spots have to be to count as the same one, in ms.
 *
 * Tapping the button twice should not leave two bookmarks eight seconds apart -
 * that is a mis-tap, not two places - and it is what lets the same button
 * UNDROP the one just dropped. Fifteen seconds is about a sentence of narration.
 */
export const SAME_SPOT_MS = 15_000;

/** The bookmark already standing at this spot, if there is one. */
export function bookmarkAt(server: string, trackId: number, positionMs: number): Bookmark | null {
  return (
    read().find(
      (b) =>
        b.server === server &&
        b.trackId === trackId &&
        Math.abs(b.positionMs - positionMs) <= SAME_SPOT_MS,
    ) ?? null
  );
}

/**
 * Drop one, or lift the one already here.
 *
 * Returns what it did, so the caller can say so - a control that silently does
 * one of two opposite things is a control nobody trusts.
 */
export function toggleBookmark(mark: Omit<Bookmark, 'at'>): 'added' | 'removed' {
  const standing = bookmarkAt(mark.server, mark.trackId, mark.positionMs);
  if (standing) {
    write(read().filter((b) => b !== standing && !sameMark(b, standing)));
    return 'removed';
  }
  write([...read(), { ...mark, at: Date.now() }]);
  return 'added';
}

export function removeBookmark(mark: Bookmark): void {
  write(read().filter((b) => !sameMark(b, mark)));
}

function sameMark(a: Bookmark, b: Bookmark): boolean {
  return a.server === b.server && a.trackId === b.trackId && a.positionMs === b.positionMs;
}
