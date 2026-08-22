import { Modal, Text } from '@glacier/react';
import { BookAudio, Check, ChevronRight, Play } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginPageProps } from '../types.ts';
import { useLibrary } from '../../app/library/library.tsx';
import { useServerSession } from '../../app/servers/serverSession.tsx';
import { fetchPlayStates } from '../../app/api/listening.ts';
import type { Track } from '../../app/core/tauri.ts';

/*
 * Restored 2026-08-22. This page was deleted whole on 12 August when
 * audiobooks came out of the app, and comes back unchanged except for the
 * import paths, which moved when src/app was split into folders. Everything it
 * depends on survived that removal untouched - the player still walks chapters
 * and still keeps the bookmark - which is why bringing books back is a much
 * smaller job than taking them out was.
 */

/**
 * The Books shelf: the CORE of audiobooks - reading, not acquiring. It shows
 * every `kind = 'book'` file the library holds, however it got there (a
 * downloader plugin, a dropped file), and plays it back with its place kept.
 *
 * Two shapes live side by side here and read the same on the shelf:
 *  - a book that is MANY files (LibriVox sections) - a chapter is a track, and
 *    "where you are" is the furthest-touched one;
 *  - a book that is ONE file (an Audible m4b) - a chapter is a marker inside it,
 *    and "where you are" is which marker the saved position sits in.
 * The Player keeps the bookmark and walks the chapters for both.
 */

/** afm://<id> -> id, the app's remote-path shape, for matching the bookmark
 *  ledger (which is keyed by track id). */
function serverId(path: string): number | null {
  if (!path.startsWith('afm://')) return null;
  const n = Number.parseInt(path.slice('afm://'.length), 10);
  return Number.isFinite(n) ? n : null;
}

interface Chapter {
  title: string;
  /** Offset within its track (ms) - 0 for a per-file chapter, the marker's own
   *  offset for a single-file one. */
  startMs: number;
  /** The track to play for this chapter (the section, or the one m4b). */
  track: Track;
}

interface ShelfBook {
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

/** Group the library's book tracks into books: album is the book, artist the
 *  author. A control character joins the key so no real title collides two. */
function shelve(books: Track[]): ShelfBook[] {
  const byBook = new Map<string, Track[]>();
  for (const t of books) {
    const key = `${t.artist}${t.album}`;
    const list = byBook.get(key);
    if (list) list.push(t);
    else byBook.set(key, [t]);
  }
  const shelved: ShelfBook[] = [];
  for (const [key, tracks] of byBook) {
    tracks.sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0));
    const first = tracks[0]!;
    const singleFile = tracks.length === 1 && (first.chapters?.length ?? 0) > 0;
    const chapters: Chapter[] = singleFile
      ? first.chapters!.map((c) => ({ title: c.title, startMs: c.startMs, track: first }))
      : tracks.map((t) => ({ title: t.title, startMs: 0, track: t }));
    shelved.push({
      key,
      title: first.album || first.title,
      author: first.artist,
      cover: tracks.find((t) => t.artwork)?.artwork ?? null,
      singleFile,
      chapters,
      tracks,
    });
  }
  shelved.sort((a, b) => a.title.localeCompare(b.title));
  return shelved;
}

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function BooksPage({ onPlay }: PluginPageProps) {
  const { session } = useServerSession();
  const { books } = useLibrary();
  const shelf = useMemo(() => shelve(books), [books]);

  const [marks, setMarks] = useState<Map<number, { positionMs: number; updatedAt: number }>>(
    new Map(),
  );
  const refreshMarks = useCallback(() => {
    if (!session) return;
    void fetchPlayStates(session)
      .then((states) => setMarks(new Map(states.map((s) => [s.trackId, s]))))
      .catch(() => {});
  }, [session]);
  useEffect(() => {
    refreshMarks();
  }, [refreshMarks]);

  /** Where a book stands: which chapter, and how far into it. */
  const standing = useCallback(
    (book: ShelfBook): { index: number; positionMs: number; started: boolean } => {
      if (book.singleFile) {
        const id = serverId(book.tracks[0]!.path);
        const mark = id !== null ? marks.get(id) : undefined;
        if (!mark) return { index: 0, positionMs: 0, started: false };
        let idx = 0;
        for (let i = 0; i < book.chapters.length; i++) {
          if (mark.positionMs >= book.chapters[i]!.startMs - 1000) idx = i;
          else break;
        }
        return { index: idx, positionMs: mark.positionMs, started: mark.positionMs > 1000 };
      }
      let best: { index: number; positionMs: number; at: number } | null = null;
      book.chapters.forEach((c, i) => {
        const id = serverId(c.track.path);
        const mark = id !== null ? marks.get(id) : undefined;
        if (mark && (!best || mark.updatedAt > best.at)) {
          best = { index: i, positionMs: mark.positionMs, at: mark.updatedAt };
        }
      });
      if (best) {
        const b = best as { index: number; positionMs: number };
        return { index: b.index, positionMs: b.positionMs, started: true };
      }
      return { index: 0, positionMs: 0, started: false };
    },
    [marks],
  );

  /** Start (or resume) a book. Single file: play it and let the Player restore
   *  the bookmark and walk its chapters. Many files: start the standing section
   *  with the rest queued behind it. */
  const readBook = (book: ShelfBook) => {
    const at = standing(book);
    const track = book.singleFile ? book.tracks[0]! : book.chapters[at.index]!.track;
    onPlay(track, book.tracks);
    window.setTimeout(refreshMarks, 2_000);
  };

  const [open, setOpen] = useState<ShelfBook | null>(null);

  if (shelf.length === 0) {
    return (
      <div className="discoverPage booksPage">
        <header className="discoverHead">
          <span className="discoverHead__glyph" aria-hidden>
            <BookAudio size={22} />
          </span>
          <div className="discoverHead__text">
            <h1 className="discoverHead__title">Books</h1>
            <p className="discoverHead__blurb">Your audiobook shelf.</p>
          </div>
        </header>
        <Text tone="muted" size="sm">
          No audiobooks yet. Add a downloader plugin (Audible, or the free LibriVox catalogue) to
          fill the shelf — anything it saves shows up here.
        </Text>
      </div>
    );
  }

  return (
    <div className="discoverPage booksPage">
      <header className="discoverHead">
        <span className="discoverHead__glyph" aria-hidden>
          <BookAudio size={22} />
        </span>
        <div className="discoverHead__text">
          <h1 className="discoverHead__title">Books</h1>
          <p className="discoverHead__blurb">Your shelf — pick up where you left off.</p>
        </div>
      </header>

      <section className="discoverSection">
        <div className="booksShelf">
          {shelf.map((book) => {
            const at = standing(book);
            return (
              <div key={book.key} className="bookCard">
                <button
                  type="button"
                  className="bookCard__body"
                  onClick={() => readBook(book)}
                  aria-label={`${at.started ? 'Continue' : 'Start'} ${book.title}`}
                >
                  <span className="bookCard__cover">
                    {book.cover ? (
                      <img src={book.cover} alt="" loading="lazy" />
                    ) : (
                      <BookAudio size={26} aria-hidden />
                    )}
                    <span className="bookCard__play" aria-hidden>
                      <Play size={16} />
                    </span>
                  </span>
                  <span className="bookCard__title">{book.title}</span>
                  <span className="bookCard__author">{book.author}</span>
                  <span className="bookCard__standing">
                    {at.started
                      ? `Ch ${at.index + 1} of ${book.chapters.length} · ${minutes(at.positionMs)} in`
                      : `${book.chapters.length} ${book.chapters.length === 1 ? 'chapter' : 'chapters'}`}
                  </span>
                </button>
                {book.chapters.length > 1 && (
                  <button
                    type="button"
                    className="bookCard__chapters"
                    aria-label={`Chapters of ${book.title}`}
                    onClick={() => setOpen(book)}
                  >
                    <ChevronRight size={14} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {open && (
        <Modal open onClose={() => setOpen(null)} title={open.title}>
          <div className="bookChapters">
            {(() => {
              const at = standing(open);
              return open.chapters.map((c, i) => {
                const here = i === at.index && at.started;
                return (
                  <button
                    key={i}
                    type="button"
                    className="bookChapters__row"
                    data-current={here || undefined}
                    onClick={() => {
                      // Many files: play this section. One file: resume the book
                      // (the Player's chapter skip walks within it).
                      onPlay(open.singleFile ? open.tracks[0]! : c.track, open.tracks);
                      setOpen(null);
                      window.setTimeout(refreshMarks, 2_000);
                    }}
                  >
                    <span className="bookChapters__n">{here ? <Play size={13} /> : i + 1}</span>
                    <span className="bookChapters__title">{c.title}</span>
                    {here && <Check size={14} aria-hidden />}
                  </button>
                );
              });
            })()}
          </div>
        </Modal>
      )}
    </div>
  );
}
