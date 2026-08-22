import { Button, Modal, ProgressBar, Text } from '@glacier/react';
import { BookAudio, BookOpenText, Check, ChevronRight, Heart, Play, Upload } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PluginPageProps } from '../types.ts';
import { useLibrary } from '../../app/library/library.tsx';
import { useServerSession } from '../../app/servers/serverSession.tsx';
import { fetchPlayStates } from '../../app/api/listening.ts';
import { uploadFile } from '../../app/api/library.ts';
import { request, ServerError } from '../../app/api/http.ts';
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

/**
 * Add a book you already have.
 *
 * A plain file input rather than the native picker the desktop upload pane
 * uses, and that is the whole point: `dialog.open` plus the filesystem plugin
 * reads a path off a disk, which is why that pane is desktop-only - and a
 * bought audiobook is very often sitting on the PHONE. A file input is the one
 * mechanism both have, because Android's webview implements the file chooser
 * and every desktop webview opens a native panel for it. The `File` it hands
 * back already has the shape `uploadFile` wants: a name, a size, and slices.
 *
 * Where it LANDS is the server's business, not this button's. An upload is
 * filed by its own tags and extension, and a book goes to `Audiobooks/` - which
 * is what gets its chapters read and keeps it off the music shelves. So this
 * does not have to say "this is a book"; it only has to hand the file over.
 */
function AddBook({ onAdded }: { onAdded: () => void }) {
  const { session } = useServerSession();
  const input = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [fraction, setFraction] = useState(0);
  const [note, setNote] = useState<string | null>(null);

  // Uploading needs somewhere to upload TO. Local libraries have no such thing,
  // and a button that cannot work is worse than no button.
  if (!session) return null;

  const take = async (files: FileList | null) => {
    const chosen = [...(files ?? [])];
    if (chosen.length === 0) return;
    setBusy(true);
    setNote(null);
    let done = 0;
    try {
      for (const file of chosen) {
        await uploadFile(
          session,
          {
            name: file.name,
            size: file.size,
            slice: async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer()),
          },
          {
            onProgress: (f) => setFraction((done + f) / chosen.length),
          },
        );
        done += 1;
        setFraction(done / chosen.length);
      }
      // The server indexes on finish, but this device is holding its own copy
      // of the library - so ask for the walk and the re-sync, or the shelf
      // stays empty behind a book that is already there.
      await onAdded();
      setNote(chosen.length === 1 ? `Added ${chosen[0]!.name}` : `Added ${chosen.length} files`);
    } catch (e) {
      // The server refuses for reasons worth repeating verbatim: a format it
      // does not take, a file over the ceiling, a full library quota.
      setNote(e instanceof Error ? e.message : 'that upload did not go through');
    } finally {
      setBusy(false);
      setFraction(0);
      if (input.current) input.current.value = '';
    }
  };

  return (
    <div className="booksAdd">
      <input
        ref={input}
        type="file"
        multiple
        className="booksAdd__input"
        // The formats the server takes, m4b first - it is what a bought
        // audiobook almost always is. `audio/*` keeps a picker that ignores
        // extensions from showing an empty folder.
        accept=".m4b,.m4a,.mp3,.aac,.flac,.wav,.aiff,.aif,.ogg,.oga,.opus,audio/*"
        onChange={(e) => void take(e.currentTarget.files)}
      />
      <Button
        variant="soft"
        size="sm"
        disabled={busy}
        onClick={() => input.current?.click()}
      >
        <Upload size={15} /> {busy ? 'Adding…' : 'Add a book'}
      </Button>
      {busy && <ProgressBar value={Math.round(fraction * 100)} aria-label="Uploading" />}
      {note && !busy && (
        <Text tone="muted" size="xs">
          {note}
        </Text>
      )}
    </div>
  );
}

/**
 * Can this hub read a book aloud back to us, and if not, why not.
 *
 * Asked ONCE per session and shared by every card - forty books must not mean
 * forty identical status calls. Three answers, because three different things
 * look the same from a card and want different words:
 *  - `ready`   the recogniser and a model are both there;
 *  - `missing` the server answered, and has neither;
 *  - `stale`   the server does not know the route at all, which means it is
 *              running a build from before reading along existed. That is the
 *              likeliest case the day this ships, and the one that used to be
 *              indistinguishable from a broken button.
 */
type Readiness = 'asking' | 'ready' | 'noTool' | 'noModel' | 'stale';
let sharedReadiness: Promise<Readiness> | null = null;

function useTranscribeStatus(): Readiness {
  const { session } = useServerSession();
  const [ready, setReady] = useState<Readiness>('asking');
  useEffect(() => {
    if (!session) return;
    sharedReadiness ??= request<{ available: boolean; toolInstalled: boolean }>(
      session.url,
      '/api/transcribe/status',
      { token: session.token },
    )
      // The two halves fail separately and want different words: a hub with no
      // recogniser needs a program installed, a hub with no model needs a
      // download. Saying "no recogniser" to somebody who has one sends them
      // to reinstall something that is already there.
      .then((r): Readiness => (r.available ? 'ready' : r.toolInstalled ? 'noModel' : 'noTool'))
      .catch((e: unknown): Readiness =>
        e instanceof ServerError && e.status === 404 ? 'stale' : 'noTool',
      );
    let live = true;
    void sharedReadiness.then((r) => {
      if (live) setReady(r);
    });
    return () => {
      live = false;
    };
  }, [session]);
  return ready;
}

/**
 * Ask the hub to read the book, so its words can be read along with it.
 *
 * Deliberately a request rather than something that happens on its own. This
 * is hours of the machine's time for one book - the same class of expense as
 * separating stems, and the same answer: nothing starts until somebody asks
 * for it. Admin-only on the server for the same reason, so a listener who is
 * not the operator simply never sees this.
 *
 * Once made, nothing here shows it: the words appear where a song's lyrics
 * would, over the disc and in the lyrics panel, because a transcript IS timed
 * lines and those surfaces already draw them.
 */
function ReadAlong({ book }: { book: ShelfBook }) {
  const { session } = useServerSession();
  const ready = useTranscribeStatus();
  const [state, setState] = useState<'idle' | 'asking' | 'working' | 'done'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  // Only the operator can spend the box's evening, and only a book that is one
  // file has a track id worth transcribing.
  if (!session?.isAdmin || book.tracks.length !== 1) return null;
  const id = serverId(book.tracks[0]!.path);
  if (id == null) return null;

  /*
   * Say why BEFORE the press, not after it.
   *
   * This used to be a live-looking button that answered every failure with
   * "Not available" - which is what a hub without the recogniser, a hub that
   * has not been updated, and a genuine error all looked like. The status is
   * asked for once per session and the button wears the answer, and when
   * something does go wrong the SERVER'S own words are shown rather than a
   * word of ours that fits every case and explains none.
   */
  if (ready === 'noTool') {
    return (
      <span className="bookCard__readAlong" title="Install whisper.cpp on the server to transcribe books">
        <BookOpenText size={13} aria-hidden /> No recogniser
      </span>
    );
  }
  if (ready === 'noModel') {
    return (
      <span className="bookCard__readAlong" title="The server has the recogniser but no model to read with — re-run home-install.sh and take the model">
        <BookOpenText size={13} aria-hidden /> No speech model
      </span>
    );
  }
  if (ready === 'stale') {
    return (
      <span className="bookCard__readAlong" title="This server predates reading along - update it and this appears">
        <BookOpenText size={13} aria-hidden /> Update your hub
      </span>
    );
  }

  const ask = async () => {
    setState('asking');
    setProblem(null);
    try {
      const r = await request<{ queued: boolean; reason?: string }>(
        session.url,
        `/api/transcribe/${id}`,
        { method: 'POST', token: session.token },
      );
      setState(r.queued ? 'working' : 'done');
    } catch (e) {
      setState('idle');
      // The server explains itself well - no recogniser, no model, not a book.
      // Repeat it rather than replacing it with a word of our own.
      setProblem(e instanceof Error ? e.message : 'that did not go through');
    }
  };

  const label =
    state === 'working' ? 'Reading it…' : state === 'done' ? 'Already read' : 'Read along';

  return (
    <span className="bookCard__readAlongWrap">
      <button
        type="button"
        className="bookCard__readAlong"
        aria-label={`Transcribe ${book.title} so you can read along`}
        disabled={state !== 'idle' || ready === 'asking'}
        onClick={() => void ask()}
      >
        <BookOpenText size={13} aria-hidden /> {label}
      </button>
      {problem && (
        <Text tone="muted" size="xs" className="bookCard__readAlongWhy">
          {problem}
        </Text>
      )}
    </span>
  );
}

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
  const { books, rescan, isFavorite, toggleFavorite } = useLibrary();
  const shelf = useMemo(() => shelve(books), [books]);
  /*
   * A book is a favourite when ANY of its files is hearted, and hearting it
   * hearts all of them.
   *
   * The heart is per TRACK, and a book is not always one track - a LibriVox
   * reading is one file per chapter. Marking only the first would make the
   * shelf disagree with itself the moment anything hearted a section directly,
   * so the rule is the one that cannot surprise: any means yes, and the toggle
   * applies to the whole book.
   *
   * Safe to reuse the music heart for this: `favoriteTracks` is built from the
   * music-only list, so a hearted book never turns up in Liked songs.
   */
  const isFavouriteBook = (book: ShelfBook) => book.tracks.some((t) => isFavorite(t.path));
  const toggleBook = (book: ShelfBook) => {
    const on = !isFavouriteBook(book);
    for (const t of book.tracks) {
      if (isFavorite(t.path) !== on) toggleFavorite(t.path);
    }
  };
  const favourites = shelf.filter(isFavouriteBook);
  const rest = shelf.filter((b) => !isFavouriteBook(b));

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
          <AddBook onAdded={rescan} />
        </header>
        <Text tone="muted" size="sm">
          {/* Names the free catalogue by the label it actually wears in the
              navigation, and does not tell anyone to install it: LibriVox
              ships as a default plugin, so for a new person it is already
              there. Saying "install a downloader plugin" sent them looking in
              Settings for something they had. */}
          No audiobooks yet. Open <strong>Free books</strong> for the LibriVox catalogue — thousands
          of public-domain readings, free and legal to keep — or add one you already own with the
          button above. Anything that lands in the library shows up here.
        </Text>
      </div>
    );
  }

  /** One card. Identical in both shelves - a favourite is the same book, in a
   *  different place on the page. */
  const card = (book: ShelfBook) => {
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
      className="bookCard__heart"
      aria-label={`${isFavouriteBook(book) ? 'Remove' : 'Add'} ${book.title} ${isFavouriteBook(book) ? 'from' : 'to'} favourites`}
      aria-pressed={isFavouriteBook(book)}
      onClick={() => toggleBook(book)}
    >
      <Heart size={14} />
    </button>
    <ReadAlong book={book} />
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
  };

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
        <AddBook onAdded={rescan} />
      </header>

      {favourites.length > 0 && (
        <section className="discoverSection">
          {/* Its own shelf rather than a filter, because "the ones I am
              actually reading" is a different question from "everything I
              own", and on a shelf of forty the difference is the whole point. */}
          <h2 className="discoverSection__title">Favourites</h2>
          <div className="booksShelf">{favourites.map(card)}</div>
        </section>
      )}
      <section className="discoverSection">
        {favourites.length > 0 && <h2 className="discoverSection__title">All books</h2>}
        <div className="booksShelf">{rest.map(card)}</div>
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
