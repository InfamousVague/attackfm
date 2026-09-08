import { describe, expect, it } from 'vitest';
import { chapterOrder, isFavouriteBook, shelve } from './bookShelf.ts';
import { track } from '../../test/libraryFixtures.ts';

/**
 * Book files, grouped into books. Getting the ORDER wrong here is not
 * cosmetic - it is the book read in the wrong order for twelve hours.
 */
describe('chapterOrder', () => {
  it('uses track numbers where the tags carry them', () => {
    const rows = [track({ trackNo: 3 }), track({ trackNo: 1 }), track({ trackNo: 2 })];
    expect(rows.sort(chapterOrder).map((t) => t.trackNo)).toEqual([1, 2, 3]);
  });

  it('falls back to the NAME, compared numerically, for an untagged split book', () => {
    // The whole reason the fallback exists: a plain string compare puts
    // "Chapter 10" before "Chapter 2", which is the book out of order.
    const rows = [
      track({ trackNo: null, title: 'Chapter 10' }),
      track({ trackNo: null, title: 'Chapter 2' }),
      track({ trackNo: null, title: 'Chapter 1' }),
    ];
    expect(rows.sort(chapterOrder).map((t) => t.title)).toEqual([
      'Chapter 1',
      'Chapter 2',
      'Chapter 10',
    ]);
  });

  it('puts every tagged file ahead of every untagged one', () => {
    const tagged = track({ trackNo: 5, title: 'Chapter 5' });
    const untagged = track({ trackNo: null, title: 'Chapter 1' });
    expect([untagged, tagged].sort(chapterOrder)).toEqual([tagged, untagged]);
  });

  it('sorts by path when a file has neither a number nor a title', () => {
    const rows = [
      track({ trackNo: null, title: '', path: '/books/part-10.mp3' }),
      track({ trackNo: null, title: '', path: '/books/part-2.mp3' }),
    ];
    expect(rows.sort(chapterOrder).map((t) => t.path)).toEqual([
      '/books/part-2.mp3',
      '/books/part-10.mp3',
    ]);
  });

  it('compares two equal numbers by name rather than leaving them as handed over', () => {
    const rows = [
      track({ trackNo: 1, title: 'B side' }),
      track({ trackNo: 1, title: 'A side' }),
    ];
    expect(rows.sort(chapterOrder).map((t) => t.title)).toEqual(['A side', 'B side']);
  });
});

describe('shelve', () => {
  const section = (n: number, over = {}) =>
    track({
      kind: 'book',
      artist: 'Ursula K. Le Guin',
      album: 'A Wizard of Earthsea',
      title: `Chapter ${n}`,
      trackNo: n,
      ...over,
    });

  it('makes one book of one album by one author, in reading order', () => {
    const [book] = shelve([section(2), section(1), section(3)]);
    expect(book?.title).toBe('A Wizard of Earthsea');
    expect(book?.author).toBe('Ursula K. Le Guin');
    expect(book?.singleFile).toBe(false);
    expect(book?.chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    // A per-file chapter starts at the top of its own file.
    expect(book?.chapters.every((c) => c.startMs === 0)).toBe(true);
  });

  it('reads a single m4b’s own markers instead of its one file', () => {
    const m4b = track({
      kind: 'book',
      artist: 'Author',
      album: 'One File Book',
      chapters: [
        { title: 'One', startMs: 0 },
        { title: 'Two', startMs: 900_000 },
      ],
    });
    const [book] = shelve([m4b]);
    expect(book?.singleFile).toBe(true);
    expect(book?.chapters.map((c) => c.startMs)).toEqual([0, 900_000]);
    // Every chapter plays the same file.
    expect(book?.chapters.every((c) => c.track === m4b)).toBe(true);
  });

  it('does NOT call a lone file with no markers a single-file book', () => {
    // The flip side of the rule above: one section file of a book whose other
    // parts have not landed yet is still a per-file book.
    const [book] = shelve([track({ kind: 'book', album: 'Half A Book', chapters: [] })]);
    expect(book?.singleFile).toBe(false);
    expect(book?.chapters).toHaveLength(1);
  });

  it('keeps two books apart, and two authors’ books of the same name apart', () => {
    const shelved = shelve([
      section(1),
      track({ kind: 'book', artist: 'Someone Else', album: 'A Wizard of Earthsea' }),
    ]);
    expect(shelved).toHaveLength(2);
  });

  it('takes the first cover any section carries', () => {
    const [book] = shelve([section(1), section(2, { artwork: 'cover.jpg' })]);
    expect(book?.cover).toBe('cover.jpg');
  });
});

describe('isFavouriteBook', () => {
  const book = shelve([
    track({ kind: 'book', album: 'B', path: '/b/1.mp3', trackNo: 1 }),
    track({ kind: 'book', album: 'B', path: '/b/2.mp3', trackNo: 2 }),
    track({ kind: 'book', album: 'B', path: '/b/3.mp3', trackNo: 3 }),
  ])[0]!;

  it('is true when ANY section is hearted, not only the first', () => {
    // A book hearted from its third file is a hearted book.
    expect(isFavouriteBook(book, (p) => p === '/b/3.mp3')).toBe(true);
  });

  it('is false when none is', () => {
    expect(isFavouriteBook(book, () => false)).toBe(false);
  });
});
