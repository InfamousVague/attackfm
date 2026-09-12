import { describe, expect, it } from 'vitest';
import {
  BOOK_COLLECTION_FOLDER,
  bookInCollection,
  collectionBooks,
  isBookCollection,
  isMusicPlaylist,
  isReservedFolder,
  pathsWithBook,
  pathsWithoutBook,
} from './collections.ts';
import { shelve } from '../library/bookShelf.ts';
import { track } from '../../test/libraryFixtures.ts';

/**
 * The line between a list of songs and a list of books.
 *
 * Both are playlists in the store, and the folder is the ONLY thing that
 * tells them apart - so this predicate is what keeps a twelve-hour reading
 * out of "Add to playlist" and a gym mix off the Books shelf. It fails in
 * both directions, like the generated-folder gate beside it, and for the
 * same reasons.
 */
describe('isBookCollection', () => {
  it('is the reserved folder, exactly', () => {
    expect(isBookCollection({ folder: BOOK_COLLECTION_FOLDER })).toBe(true);
    expect(isBookCollection({ folder: 'Books' })).toBe(true);
    expect(isBookCollection({ folder: 'books' })).toBe(false);
    expect(isBookCollection({ folder: 'Books ' })).toBe(false);
    expect(isBookCollection({ folder: 'Audiobooks' })).toBe(false);
  });

  it('lets an unfiled list through - most lists are in no folder', () => {
    expect(isBookCollection({})).toBe(false);
    expect(isBookCollection({ folder: '' })).toBe(false);
    expect(isBookCollection({ folder: undefined })).toBe(false);
  });

  it('reads the FOLDER, never the name', () => {
    expect(isBookCollection({ name: 'Books' } as { folder?: string })).toBe(false);
  });
});

describe('isMusicPlaylist', () => {
  it('is neither the server’s nor the shelf’s', () => {
    // The two gates every music surface applies, as one predicate: a list
    // that passes this is a list a person keeps for songs.
    expect(isMusicPlaylist({ folder: '' })).toBe(true);
    expect(isMusicPlaylist({ folder: 'Road trips' })).toBe(true);
    expect(isMusicPlaylist({ folder: 'Charts' })).toBe(false);
    expect(isMusicPlaylist({ folder: 'New music' })).toBe(false);
    expect(isMusicPlaylist({ folder: 'Books' })).toBe(false);
  });
});

describe('isReservedFolder', () => {
  it('refuses the app’s own folder names to a hand-filed list', () => {
    // A music list filed under Books would BECOME a collection; one filed
    // under Charts would detach from the server's refresh.
    expect(isReservedFolder('Books')).toBe(true);
    expect(isReservedFolder('Charts')).toBe(true);
    expect(isReservedFolder('New music')).toBe(true);
    expect(isReservedFolder('Bookshelf')).toBe(false);
    expect(isReservedFolder('')).toBe(false);
  });
});

/** Two sectioned books and one m4b, as the library would hold them. */
function library() {
  const ascent = [
    track({ path: 'afm://1', artist: 'Ada Sorrel', album: 'The Long Ascent', title: 'Chapter 1', trackNo: null }),
    track({ path: 'afm://2', artist: 'Ada Sorrel', album: 'The Long Ascent', title: 'Chapter 2', trackNo: null }),
    track({ path: 'afm://3', artist: 'Ada Sorrel', album: 'The Long Ascent', title: 'Chapter 10', trackNo: null }),
  ];
  const tangle = [
    track({ path: 'afm://4', artist: 'Ada Sorrel', album: 'The Iron Tangle', title: 'Part 1', trackNo: 1 }),
    track({ path: 'afm://5', artist: 'Ada Sorrel', album: 'The Iron Tangle', title: 'Part 2', trackNo: 2 }),
  ];
  const single = [
    track({
      path: 'afm://6',
      artist: 'Ben Ochre',
      album: 'One File',
      title: 'One File',
      chapters: [
        { title: 'Opening', startMs: 0 },
        { title: 'Middle', startMs: 60_000 },
      ],
    }),
  ];
  return { ascent, tangle, single, all: [...ascent, ...tangle, ...single] };
}

describe('collectionBooks', () => {
  it('groups the paths into books, in the order the LIST holds them', () => {
    // `shelve` sorts by title, which would put The Iron Tangle first. A
    // collection is a running order, so the book filed first comes first.
    const { all, ascent, tangle } = library();
    const paths = [...ascent.map((t) => t.path), ...tangle.map((t) => t.path)];
    const books = collectionBooks(paths, all);
    expect(books.map((b) => b.title)).toEqual(['The Long Ascent', 'The Iron Tangle']);
  });

  it('settles each book’s chapters into reading order, however they were filed', () => {
    const { all } = library();
    // Filed backwards and out of numeric order.
    const books = collectionBooks(['afm://3', 'afm://1', 'afm://2'], all);
    expect(books).toHaveLength(1);
    expect(books[0]!.tracks.map((t) => t.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 10']);
  });

  it('keeps a single-file book’s markers as its chapters', () => {
    const { all } = library();
    const [book] = collectionBooks(['afm://6'], all);
    expect(book?.singleFile).toBe(true);
    expect(book?.chapters.map((c) => c.title)).toEqual(['Opening', 'Middle']);
  });

  it('drops a path the library no longer holds, like every playlist does', () => {
    const { all } = library();
    expect(collectionBooks(['afm://999', 'afm://4', 'afm://5'], all).map((b) => b.title)).toEqual([
      'The Iron Tangle',
    ]);
  });

  it('shows a half-filed book rather than hiding it', () => {
    const { all } = library();
    const [book] = collectionBooks(['afm://2'], all);
    expect(book?.title).toBe('The Long Ascent');
    expect(book?.tracks).toHaveLength(1);
  });

  it('is empty for an empty list', () => {
    expect(collectionBooks([], library().all)).toEqual([]);
  });
});

describe('bookInCollection / pathsWithBook / pathsWithoutBook', () => {
  it('a book is in the list only when EVERY section is', () => {
    const { ascent } = library();
    const [book] = shelve(ascent);
    expect(bookInCollection(book!, ['afm://1', 'afm://2', 'afm://3'])).toBe(true);
    expect(bookInCollection(book!, ['afm://1', 'afm://2'])).toBe(false);
    expect(bookInCollection(book!, [])).toBe(false);
  });

  it('adds the whole book, in reading order, after what is there', () => {
    const { ascent } = library();
    const [book] = shelve(ascent);
    expect(pathsWithBook(['afm://9'], book!)).toEqual(['afm://9', 'afm://1', 'afm://2', 'afm://3']);
  });

  it('leaves a section already present where it sits and fills in the rest', () => {
    const { ascent } = library();
    const [book] = shelve(ascent);
    expect(pathsWithBook(['afm://2', 'afm://9'], book!)).toEqual(['afm://2', 'afm://9', 'afm://1', 'afm://3']);
  });

  it('takes every section out and nothing else', () => {
    const { ascent } = library();
    const [book] = shelve(ascent);
    expect(pathsWithoutBook(['afm://9', 'afm://1', 'afm://2', 'afm://3', 'afm://4'], book!)).toEqual([
      'afm://9',
      'afm://4',
    ]);
  });
});
