/*
 * Book FILES, grouped into books.
 *
 * The library keeps audiobooks apart from `tracks` on purpose - a twelve-hour
 * reading loose among the songs is the wrong thing in a mix, in shuffle and in
 * search - so every surface that wants to show books has to do this grouping
 * first. It lived inside the Books plugin, which was fine while the shelf was
 * the only such surface; search and the library page want it too, and an app
 * module must not reach into a plugin for it.
 *
 * One book is one album by one author. A book is either ONE file carrying its
 * own chapter markers (an m4b) or MANY section files, and everything downstream
 * has to handle both, so the shape is settled here once.
 */

import type { Track } from '../core/tauri.ts';

export interface Chapter {
  title: string;
  /** Offset within its track (ms) - 0 for a per-file chapter, the marker's own
   *  offset for a single-file one. */
  startMs: number;
  /** The track to play for this chapter (the section, or the one m4b). */
  track: Track;
}

export interface ShelfBook {
  key: string;
  title: string;
  author: string;
  cover: string | null;
  /** One m4b carrying its own chapter markers, vs many section files. */
  singleFile: boolean;
  chapters: Chapter[];
  /** The whole book in reading order - the queue a play starts with. */
  tracks: Track[];
}

/**
 * The order a book's files are meant to be heard in.
 *
 * Track numbers first, where they exist. They very often do NOT: a book
 * downloaded as split MP3s frequently carries no tags at all, and a plain
 * `(a.trackNo ?? 0) - (b.trackNo ?? 0)` then compares zero with zero for every
 * pair and leaves the chapters in whatever order the library handed them over.
 * For an audiobook that is not cosmetic; it is the book in the wrong order.
 *
 * So the fallback is the name, compared NUMERICALLY - `numeric: true` is what
 * puts "Chapter 2" before "Chapter 10" instead of after it, which a plain string
 * compare gets backwards and which is exactly how these files are named. An
 * untagged file's title is already its filename, so this sorts by what is on
 * disk.
 */
export function chapterOrder(a: Track, b: Track): number {
  const an = a.trackNo ?? 0;
  const bn = b.trackNo ?? 0;
  if (an !== bn && an > 0 && bn > 0) return an - bn;
  if (an > 0 !== bn > 0) return an > 0 ? -1 : 1;
  return (a.title || a.path).localeCompare(b.title || b.path, undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/** Group the library's book tracks into books: album is the book, artist the
 *  author. A control character joins the key so no real title collides two. */
export function shelve(books: readonly Track[]): ShelfBook[] {
  const byBook = new Map<string, Track[]>();
  for (const t of books) {
    const key = `${t.artist}\x1f${t.album}`;
    const list = byBook.get(key);
    if (list) list.push(t);
    else byBook.set(key, [t]);
  }
  const shelved: ShelfBook[] = [];
  for (const [key, tracks] of byBook) {
    const ordered = [...tracks].sort(chapterOrder);
    const first = ordered[0]!;
    const singleFile = ordered.length === 1 && (first.chapters?.length ?? 0) > 0;
    const chapters: Chapter[] = singleFile
      ? first.chapters!.map((c) => ({ title: c.title, startMs: c.startMs, track: first }))
      : ordered.map((t) => ({ title: t.title, startMs: 0, track: t }));
    shelved.push({
      key,
      title: first.album || first.title,
      author: first.artist,
      cover: ordered.find((t) => t.artwork)?.artwork ?? null,
      singleFile,
      chapters,
      tracks: ordered,
    });
  }
  shelved.sort((a, b) => a.title.localeCompare(b.title));
  return shelved;
}

/**
 * A book is a favourite when ANY of its files is hearted.
 *
 * The heart is per TRACK and a book is not always one track - a sectioned
 * reading is one file per chapter - so asking about the first file only would
 * miss a book hearted from its third.
 */
export function isFavouriteBook(book: ShelfBook, isFavorite: (path: string) => boolean): boolean {
  return book.tracks.some((t) => isFavorite(t.path));
}
