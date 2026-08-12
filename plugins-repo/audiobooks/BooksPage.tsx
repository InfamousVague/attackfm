import { Button, Input, Modal, Spinner, Text } from '@glacier/react';
import { BookAudio, Check, ChevronRight, Play, Plus, Search } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLibrary } from '@attackfm/app/library';
import { useServerSession } from '@attackfm/app/serverSession';
import type { PluginPageProps } from '../../src/plugins/types.ts';
import type { Track } from '../../src/app/tauri.ts';
import {
  bookJobs,
  bookmarks as fetchBookmarks,
  importBook,
  searchBooks,
  MissingEndpointError,
  type BookJob,
  type CatalogBook,
} from './api.ts';

/**
 * The Books page: your shelf on top, the LibriVox catalogue beneath it.
 *
 * A book on the shelf is a GROUP of library tracks - the sections the server
 * filed under one album - and everything here works through the ordinary
 * library: play a chapter and the queue walks the rest, the Player keeps the
 * bookmark, the shelf reads it back to say where you are. The catalogue half
 * asks the server, which asks LibriVox, so the phone never talks to anyone
 * but its own hub.
 */

/** afm://<id> -> id. The app's own remote-path shape, restated here because a
 *  bundle may only import TYPES from the app source, never runtime code. */
function serverId(path: string): number | null {
  if (!path.startsWith('afm://')) return null;
  const n = Number.parseInt(path.slice('afm://'.length), 10);
  return Number.isFinite(n) ? n : null;
}

interface ShelfBook {
  key: string;
  title: string;
  author: string;
  cover: string | null;
  chapters: Track[];
}

/** Sections grouped into books: album is the book, artist the author. The
 *  separator is a control character so no real title can collide two books. */
function shelve(books: Track[]): ShelfBook[] {
  const byBook = new Map<string, ShelfBook>();
  for (const t of books) {
    const key = `${t.artist}\u001f${t.album}`;
    let book = byBook.get(key);
    if (!book) {
      book = { key, title: t.album, author: t.artist, cover: null, chapters: [] };
      byBook.set(key, book);
    }
    book.chapters.push(t);
    if (!book.cover && t.artwork) book.cover = t.artwork;
  }
  const shelved = [...byBook.values()];
  for (const b of shelved) {
    b.chapters.sort((x, y) => (x.trackNo ?? 0) - (y.trackNo ?? 0));
  }
  shelved.sort((x, y) => x.title.localeCompare(y.title));
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
  const { books, rescan } = useLibrary();
  const shelf = useMemo(() => shelve(books), [books]);

  // The bookmark ledger, refreshed when the page opens and after each play
  // could have moved it - cheap (one bounded fetch), and what turns a grid of
  // albums into a shelf of half-read books.
  const [marks, setMarks] = useState<Map<number, { positionMs: number; updatedAt: number }>>(
    new Map(),
  );
  const refreshMarks = useCallback(() => {
    if (!session) return;
    void fetchBookmarks(session)
      .then(setMarks)
      .catch(() => {});
  }, [session]);
  useEffect(() => {
    refreshMarks();
  }, [refreshMarks]);

  // Where a book stands: its furthest-touched chapter, by the ledger's clock.
  const standing = useCallback(
    (book: ShelfBook): { chapter: Track; index: number; positionMs: number; started: boolean } => {
      let best: { chapter: Track; index: number; positionMs: number; at: number } | null = null;
      book.chapters.forEach((c, i) => {
        const id = serverId(c.path);
        const mark = id !== null ? marks.get(id) : undefined;
        if (mark && (!best || mark.updatedAt > best.at)) {
          best = { chapter: c, index: i, positionMs: mark.positionMs, at: mark.updatedAt };
        }
      });
      if (best) {
        const b = best as { chapter: Track; index: number; positionMs: number };
        return { chapter: b.chapter, index: b.index, positionMs: b.positionMs, started: true };
      }
      return { chapter: book.chapters[0]!, index: 0, positionMs: 0, started: false };
    },
    [marks],
  );

  /** Start (or resume) a book: the standing chapter, with the rest queued
   *  behind it. The Player itself reopens the chapter mid-sentence. */
  const readBook = (book: ShelfBook) => {
    const at = standing(book);
    onPlay(at.chapter, book.chapters);
    window.setTimeout(refreshMarks, 2_000);
  };

  const [open, setOpen] = useState<ShelfBook | null>(null);

  // --- the catalogue half ---------------------------------------------------

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogBook[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const debounce = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    const q = query.trim();
    if (!session || q.length < 2) {
      setResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    debounce.current = window.setTimeout(() => {
      searchBooks(session, q)
        .then((r) => {
          setResults(r);
          setMissing(false);
        })
        .catch((e) => {
          setResults([]);
          if (e instanceof MissingEndpointError) setMissing(true);
        })
        .finally(() => setSearching(false));
    }, 450);
    return () => window.clearTimeout(debounce.current);
  }, [query, session]);

  // The download queue, polled only while something is actually moving.
  const [jobs, setJobs] = useState<BookJob[]>([]);
  const active = jobs.some((j) => j.state === 'queued' || j.state === 'downloading');
  useEffect(() => {
    if (!session) return;
    let live = true;
    const poll = () => {
      void bookJobs(session)
        .then((js) => {
          if (!live) return;
          setJobs((prev) => {
            // A job crossing the finish line pulls the library in behind it,
            // so the shelf grows without waiting for the next scheduled sync.
            const wasActive = prev.some(
              (p) => p.state === 'queued' || p.state === 'downloading',
            );
            const isActive = js.some((p) => p.state === 'queued' || p.state === 'downloading');
            if (wasActive && !isActive) void rescan();
            return js;
          });
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, active ? 3_000 : 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, active, rescan]);

  const owned = useMemo(() => {
    const set = new Set<string>();
    for (const b of shelf) set.add(`${b.author.toLowerCase()}\u001f${b.title.toLowerCase()}`);
    return set;
  }, [shelf]);

  const jobFor = (bookId: number) => jobs.find((j) => j.bookId === bookId);

  const pull = (book: CatalogBook) => {
    if (!session) return;
    setNote(null);
    void importBook(session, book.id)
      .then((job) => setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]))
      .catch((e) => setNote(e instanceof Error ? e.message : 'Could not queue that book.'));
  };

  return (
    <div className="discoverPage booksPage">
      <header className="discoverHead">
        <span className="discoverHead__glyph" aria-hidden>
          <BookAudio size={22} />
        </span>
        <div className="discoverHead__text">
          <h1 className="discoverHead__title">Books</h1>
          <p className="discoverHead__blurb">
            Your shelf, and the public-domain catalogue to grow it from.
          </p>
        </div>
      </header>

      {/* The shelf: what the library already holds, standing first because a
          half-read book is the page's whole reason to be opened. */}
      {shelf.length > 0 && (
        <section className="discoverSection">
          <h2 className="discoverSection__title">Your shelf</h2>
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
                  <button
                    type="button"
                    className="bookCard__chapters"
                    aria-label={`Chapters of ${book.title}`}
                    onClick={() => setOpen(book)}
                  >
                    <ChevronRight size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Downloads in flight, worth a glance while they run. */}
      {jobs.some((j) => j.state !== 'done') && (
        <section className="discoverSection">
          <h2 className="discoverSection__title">Arriving</h2>
          <div className="bookJobs">
            {jobs
              .filter((j) => j.state !== 'done')
              .map((j) => (
                <div key={j.id} className="bookJob" data-state={j.state}>
                  <span className="bookJob__cover">
                    {j.cover ? <img src={j.cover} alt="" loading="lazy" /> : <BookAudio size={16} />}
                  </span>
                  <span className="bookJob__text">
                    <span className="bookJob__title">{j.title}</span>
                    <span className="bookJob__sub">
                      {j.state === 'error'
                        ? (j.error ?? 'failed')
                        : j.state === 'queued'
                          ? 'Waiting its turn'
                          : `${j.completed} of ${j.total}${j.currentSection ? ` · ${j.currentSection}` : ''}`}
                    </span>
                  </span>
                  {j.state === 'downloading' && (
                    <span className="bookJob__bar" aria-hidden>
                      <span
                        className="bookJob__fill"
                        style={{ width: `${Math.round((j.completed / Math.max(1, j.total)) * 100)}%` }}
                      />
                    </span>
                  )}
                </div>
              ))}
          </div>
        </section>
      )}

      {/* The catalogue: LibriVox through the hub. */}
      <section className="discoverSection">
        <h2 className="discoverSection__title">Find a book</h2>
        <Input
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Title or author - Austen, Dickens, Sherlock Holmes"
          aria-label="Search LibriVox"
        />
        {missing && (
          <Text tone="muted" size="sm">
            Your home server doesn&apos;t have the audiobook catalogue yet - update it to search.
          </Text>
        )}
        {note && (
          <Text tone="danger" size="sm">
            {note}
          </Text>
        )}
        {searching && (
          <div className="booksSearching">
            <Spinner size="sm" aria-label="" /> <Text size="sm" tone="muted">Asking LibriVox</Text>
          </div>
        )}
        {results && results.length === 0 && !searching && !missing && (
          <Text tone="muted" size="sm">
            Nothing in the catalogue answers to that.
          </Text>
        )}
        {results && results.length > 0 && (
          <div className="bookResults">
            {results.map((b) => {
              const job = jobFor(b.id);
              const have = owned.has(`${b.author.toLowerCase()}\u001f${b.title.toLowerCase()}`);
              const busy = job && (job.state === 'queued' || job.state === 'downloading');
              return (
                <div key={b.id} className="discoverSetRow bookResult" data-static>
                  <span className="discoverSetRow__cover">
                    {b.cover ? <img src={b.cover} alt="" loading="lazy" /> : <BookAudio size={16} />}
                  </span>
                  <span className="discoverSetRow__text">
                    <span className="discoverSetRow__title">{b.title}</span>
                    <span className="discoverSetRow__sub">
                      {b.author}
                      {b.totaltime ? ` · ${b.totaltime}` : ''}
                      {` · ${b.sections} ${b.sections === 1 ? 'chapter' : 'chapters'}`}
                    </span>
                  </span>
                  <Button
                    variant={have || job?.state === 'done' ? 'ghost' : 'solid'}
                    size="sm"
                    disabled={have || busy || job?.state === 'done'}
                    onClick={() => pull(b)}
                  >
                    {have || job?.state === 'done' ? (
                      <>
                        <Check size={14} /> <span>On your shelf</span>
                      </>
                    ) : busy ? (
                      <>
                        <Spinner size="sm" aria-label="" /> <span>Arriving</span>
                      </>
                    ) : (
                      <>
                        <Plus size={14} /> <span>Add</span>
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        {!results && !searching && shelf.length === 0 && (
          <div className="booksEmpty">
            <Search size={20} aria-hidden />
            <Text tone="muted" size="sm">
              An empty shelf is one search away - the classics are all here, free.
            </Text>
          </div>
        )}
      </section>

      {/* One book, read in full: its chapters, each a place to jump to. */}
      {open && (
        <Modal open onClose={() => setOpen(null)} title={open.title} size="md">
          <div className="discoverSetList">
            <Text tone="muted" size="sm">
              {open.author} · {open.chapters.length}{' '}
              {open.chapters.length === 1 ? 'chapter' : 'chapters'}
            </Text>
            {open.chapters.map((c, i) => {
              const id = serverId(c.path);
              const mark = id !== null ? marks.get(id) : undefined;
              return (
                <button
                  key={c.path}
                  type="button"
                  className="discoverSetRow"
                  onClick={() => {
                    setOpen(null);
                    onPlay(c, open.chapters);
                    window.setTimeout(refreshMarks, 2_000);
                  }}
                >
                  <span className="discoverSetRow__cover">
                    {c.artwork ? (
                      <img src={c.artwork} alt="" loading="lazy" />
                    ) : (
                      <BookAudio size={16} />
                    )}
                  </span>
                  <span className="discoverSetRow__text">
                    <span className="discoverSetRow__title">
                      {i + 1}. {c.title}
                    </span>
                    <span className="discoverSetRow__sub">
                      {mark && mark.positionMs > 30_000 ? `${minutes(mark.positionMs)} in` : ''}
                    </span>
                  </span>
                  <span className="discoverSetRow__go" aria-hidden>
                    <Play size={14} />
                  </span>
                </button>
              );
            })}
          </div>
        </Modal>
      )}
    </div>
  );
}
