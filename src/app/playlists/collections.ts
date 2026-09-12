/**
 * Book collections: a playlist in a reserved folder, holding book files.
 *
 * A collection is not a new kind of thing. It is a playlist whose folder is
 * `Books` and whose paths are the sections of audiobooks, made and kept by
 * the same store, stored in the same table, synced by the same heartbeat.
 * What makes it a collection rather than a list is only where it is filed -
 * which is exactly how the server's chart lists are told apart from a
 * person's (see generated.ts), and for the same reason: a playlist that
 * turns up in the wrong room is worse than no playlist. A twelve-hour
 * reading listed among the Gym mixes in "Add to playlist" is the failure
 * this predicate exists to prevent, and a Gym mix on the Books shelf is the
 * other half of it.
 *
 * The test lives beside the folder name because the name IS the test, and
 * every surface that draws lists gates on one predicate or the other:
 * `isMusicPlaylist` for the music rooms, `isBookCollection` for the shelf.
 */

import type { Track } from '../core/tauri.ts';
import { shelve, type ShelfBook } from '../library/bookShelf.ts';
import { GENERATED_PLAYLIST_FOLDERS, isGeneratedPlaylist } from './generated.ts';

export const BOOK_COLLECTION_FOLDER = 'Books';

export function isBookCollection(p: { folder?: string }): boolean {
  return (p.folder ?? '') === BOOK_COLLECTION_FOLDER;
}

/** A list a MUSIC surface may draw: neither the server's nor the shelf's. */
export function isMusicPlaylist(p: { folder?: string }): boolean {
  return !isGeneratedPlaylist(p) && !isBookCollection(p);
}

/**
 * Folder names a person may not file a playlist under by hand.
 *
 * The folder is the whole mechanism, so a music list typed into a folder
 * called `Books` would BE a collection - it would leave the Library, appear
 * on the shelf, and open as a page that resolves its songs against the book
 * files and finds none. The folder forms refuse the name rather than let
 * that happen quietly; the same courtesy is extended to the server's own
 * folders, which a hand-filed list would only detach from the refresh that
 * keeps them current.
 */
export function isReservedFolder(name: string): boolean {
  return name === BOOK_COLLECTION_FOLDER || GENERATED_PLAYLIST_FOLDERS.has(name);
}

/**
 * The books a collection holds, in the ORDER it holds them.
 *
 * `shelve` sorts by title, which is right for a shelf and wrong for a list:
 * a collection is a running order - the book to read first sits first - so
 * the books come out in the order their first section appears in the paths.
 * Within a book, `shelve` still settles the chapter order, so a sectioned
 * book plays through in reading order however its paths were filed.
 *
 * A path the library no longer holds simply does not render - the same
 * favourites-style resolution every playlist uses - and a book whose files
 * are only partly in the list still counts as in it: half a book is a book
 * somebody was adding, not a book to hide.
 */
export function collectionBooks(paths: readonly string[], books: readonly Track[]): ShelfBook[] {
  const byPath = new Map(books.map((t) => [t.path, t] as const));
  const groups = new Map<string, Track[]>();
  for (const path of paths) {
    const track = byPath.get(path);
    if (!track) continue;
    const key = `${track.artist}\x1f${track.album}`;
    const list = groups.get(key);
    if (list) list.push(track);
    else groups.set(key, [track]);
  }
  const out: ShelfBook[] = [];
  for (const tracks of groups.values()) {
    const [book] = shelve(tracks);
    if (book) out.push(book);
  }
  return out;
}

/** Whether every section of the book is filed in the list. */
export function bookInCollection(book: ShelfBook, paths: readonly string[]): boolean {
  const have = new Set(paths);
  return book.tracks.length > 0 && book.tracks.every((t) => have.has(t.path));
}

/**
 * The list with the whole book appended, sections in reading order.
 *
 * Sections already present are left where they are rather than moved to the
 * end - a book half-added by hand keeps its seat, and only the missing
 * sections join it.
 */
export function pathsWithBook(paths: readonly string[], book: ShelfBook): string[] {
  const have = new Set(paths);
  return [...paths, ...book.tracks.map((t) => t.path).filter((p) => !have.has(p))];
}

/** The list with every section of the book taken out. */
export function pathsWithoutBook(paths: readonly string[], book: ShelfBook): string[] {
  const gone = new Set(book.tracks.map((t) => t.path));
  return paths.filter((p) => !gone.has(p));
}
