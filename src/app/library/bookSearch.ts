/*
 * Finding a book on your own shelf.
 *
 * Deliberately NOT the app's search page. That one asks "which of my SONGS is
 * this", running the track engine over a library books are held apart from -
 * they are kept out of `tracks` on purpose, because a twelve-hour reading loose
 * among the songs is the wrong thing in a mix, in shuffle and in search. Sending
 * a shelf through it would mean putting them back in.
 *
 * A shelf wants something smaller anyway. Twenty-five books is a list you
 * filter, not a corpus you query: type two letters and the shelves narrow. No
 * operators, no ranking, no network.
 *
 * It lives in the app rather than the Books plugin because the app's own search
 * page needs it too: books are held out of `tracks`, so the one global search
 * could not find them at all, and an app module must not reach into a plugin.
 */

/** Lower-cased and stripped of accents, so "Dinniman" finds "Dinnim\u00e1n". */
function flatten(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * What a book can be found by.
 *
 * Chapter names are in here because they are often the only place a subtitle or
 * a part name is written down - "Part Two: The Iron Tangle" lives in the
 * chapters, not in the album tag - and somebody hunting for that half-remembered
 * name has nowhere else to look.
 */
export interface Searchable {
  title: string;
  author: string;
  chapters?: readonly { title?: string | null }[];
}

function haystack(book: Searchable): string {
  const parts = [book.title, book.author];
  for (const c of book.chapters ?? []) if (c.title) parts.push(c.title);
  return flatten(parts.join('   '));
}

/**
 * Does this book answer to the query?
 *
 * EVERY word has to land, in any order and anywhere - "carl dungeon" finds
 * Dungeon Crawler Carl, and so does "crawl". Requiring all of them is what makes
 * a second word narrow the list rather than widen it, which is what typing one
 * feels like it ought to do.
 */
export function bookMatches(book: Searchable, query: string): boolean {
  const words = flatten(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = haystack(book);
  return words.every((w) => hay.includes(w));
}

/** The shelf, narrowed. Order is left alone - it is the shelf's own. */
export function filterBooks<T extends Searchable>(books: readonly T[], query: string): T[] {
  if (!query.trim()) return [...books];
  return books.filter((b) => bookMatches(b, query));
}
