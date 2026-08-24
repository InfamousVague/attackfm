import { TrackMenu } from '../../app/library/TrackMenu.tsx';
import { Button, ContextMenu, MenuItem, Modal, ProgressBar, SearchField, Spinner, Text } from '@glacier/react';
import { ArrowDownToLine, ListX, BookAudio, BookOpenText, Check, ChevronRight, Heart, Play, Trash2, Upload } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { PluginPageProps } from '../types.ts';
import { useLibrary } from '../../app/library/library.tsx';
import { useServerSession } from '../../app/servers/serverSession.tsx';
import { CoverWall } from '../../app/playlists/CoverWall.tsx';
import { chapterNumbers } from '../../app/player/chapterNumber.ts';
import {
  isFavouriteBook,
  shelve,
  type Chapter,
  type ShelfBook,
} from '../../app/library/bookShelf.ts';
import { filterBooks } from '../../app/library/bookSearch.ts';
import { fetchPlayStates } from '../../app/api/listening.ts';
import { forgetTranscript } from '../../app/player/transcript.ts';
import { forgetKeptTranscript } from '../../app/player/transcriptStore.ts';
import { keepBook, type KeepStep } from '../../app/downloads/keepBook.ts';
import { isHeld, onOfflineChange, unpinTrack } from '../../app/downloads/offline.ts';
import { forgetChapterNotes } from '../../app/player/chapterNotes.ts';
import { removeTracks, uploadFile } from '../../app/api/library.ts';
import { setHeaderActions } from '../../app/nav/headerActions.ts';
import { artSized } from '../../app/server.ts';
import { formatTotal } from '../../app/ux/format.ts';
import { useHoldToMenu } from '../../app/ux/holdToMenu.ts';
import { request, ServerError } from '../../app/api/http.ts';
import { isTauri } from '../../app/core/tauri.ts';
import type { Track } from '../../app/core/tauri.ts';
import { JOB_ACTIVE, transcribeRows, type TranscribeJob } from './transcribeRows.ts';

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
 * The page's one header.
 *
 * It used to wear `discoverHead` classes inherited from a page that no longer
 * exists, and nothing in any stylesheet matched them - so the glyph, the title,
 * the blurb and the button each took a line of their own and the header ate
 * half a phone screen before a single book appeared. One row: the mark and the
 * name together, the action opposite them, the sentence underneath in the size
 * a subtitle deserves.
 */
/**
 * The import doorway: the piles waiting in `Audiobooks/import/`, and the
 * button that sorts them in.
 *
 * A dropped download is rarely shaped like a book - one giant MP3, forty
 * numbered parts, a folder per disc, text files explaining which is which.
 * The server reads each folder's evidence, asks its own model what the pile
 * is when one is configured, and does the assembly itself: renamed into read
 * order, tagged, covered, indexed. This section only ASKS and then watches.
 *
 * Admin-only and quiet: with nothing waiting and nothing running it renders
 * nothing at all, so the shelf stays a shelf.
 */
function ImportDoorway() {
  const { session } = useServerSession();
  const [status, setStatus] = useState<{
    importDir: string;
    pending: string[];
    ai: boolean;
    jobs: { id: string; folder: string; state: string; via: string; books: string[]; error: string }[];
  } | null>(null);

  const admin = session?.isAdmin === true;
  const [asking, setAsking] = useState(false);
  const [sortErr, setSortErr] = useState<string | null>(null);
  /** The poll's own read, reachable from the button - a press must answer on
   *  the spot, not at the idle tick up to twenty seconds away. */
  const readNow = useRef<() => void>(() => {});
  /** Which server the shown status came from. A switch mid-session must not
   *  leave hub A's folders rendering as hub B's imports - with B's Sort
   *  button live under them. */
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!admin || !session) return;
    if (shownFor.current !== session.url) {
      shownFor.current = session.url;
      setStatus(null);
      setSortErr(null);
    }
    let live = true;
    let timer: number | undefined;
    const read = async () => {
      try {
        const next = await request<NonNullable<typeof status>>(
          session.url,
          '/api/audiobooks/ingest',
          { token: session.token },
        );
        if (!live) return;
        setStatus(next);
        // The 2s/20s rhythm every other watcher here keeps: quick while the
        // server is working, patient while it is not.
        const working = next.jobs.some((j) => j.state !== 'done' && j.state !== 'error');
        timer = window.setTimeout(read, working ? 2_000 : 20_000);
      } catch (e) {
        if (!live) return;
        // A hub from before this existed answers 404 - nothing to offer, stop
        // asking. Anything else is a blip: keep what we knew and try again at
        // the patient rate, because a poll that dies on its first stumble
        // makes the whole section vanish mid-errand - which is exactly what
        // it did before this branch learned the difference.
        if (e instanceof ServerError && e.status === 404) {
          setStatus(null);
          return;
        }
        timer = window.setTimeout(read, 20_000);
      }
    };
    readNow.current = () => {
      window.clearTimeout(timer);
      void read();
    };
    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [admin, session]);

  if (!admin || !session || !status) return null;
  // Read defensively rather than trusting the shape. A 404 means "no such
  // route" and is already handled above, but a 200 carrying something else -
  // a proxy's JSON error page, a half-written reply, a hub whose ingest
  // payload has moved on - used to reach `undefined.filter` and take the
  // WHOLE shelf down with it, for admins only. The doorway is the smallest
  // thing on this page; it must not be the thing that can break it.
  const jobs = status.jobs ?? [];
  const pending = status.pending ?? [];
  const active = jobs.filter((j) => j.state !== 'done' && j.state !== 'error');
  const settled = jobs.filter((j) => j.state === 'done' || j.state === 'error').slice(0, 4);
  if (pending.length === 0 && jobs.length === 0) return null;

  const sort = async () => {
    setAsking(true);
    setSortErr(null);
    try {
      await request(session.url, '/api/audiobooks/ingest', { method: 'POST', token: session.token });
      // Ask the poll to look NOW. Its idle tick is up to twenty seconds out,
      // and a button that changes nothing on screen for twenty seconds reads
      // as a dead button.
      readNow.current();
    } catch (e) {
      // A failed POST makes no job rows, so nothing downstream will ever say
      // why - it has to be said here.
      setSortErr(e instanceof Error ? e.message : 'that did not go through');
    } finally {
      setAsking(false);
    }
  };

  const stateWord = (j: { state: string }) =>
    j.state === 'reading'
      ? 'reading the folder'
      : j.state === 'thinking'
        ? 'working out what it is'
        : j.state === 'filing'
          ? 'filing the chapters'
          : j.state;

  const errored = jobs.filter((j) => j.state === 'error').length;
  const clearErrors = async () => {
    if (!session) return;
    try {
      await request(session.url, '/api/audiobooks/ingest/clear-errors', {
        method: 'POST',
        token: session.token,
      });
      readNow.current();
    } catch {
      // The list simply stays as it was; the next poll tells the truth.
    }
  };

  return (
    <section className="discoverSection">
      <div className="booksImport__head">
        <h2 className="discoverSection__title">Imports</h2>
        {errored > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void clearErrors()}
            title="Clear the failed rows; a fixed folder still in import will be offered again"
          >
            <ListX size={14} /> Clear {errored === 1 ? 'error' : 'errors'}
          </Button>
        )}
      </div>
      {pending.length > 0 && (
        <div className="booksImport__ask">
          <Text tone="muted" size="sm">
            {pending.length === 1
              ? `1 folder is waiting in import: ${pending[0]}`
              : `${pending.length} folders are waiting in import`}
            {!status.ai && ' — sorted by their names and tags; connect the local AI for smarter reads'}
          </Text>
          <Button
            variant="soft"
            size="sm"
            onClick={() => void sort()}
            disabled={active.length > 0 || asking}
          >
            <BookAudio size={15} /> {asking ? 'Asking…' : 'Sort them in'}
          </Button>
        </div>
      )}
      {sortErr && (
        <Text tone="muted" size="xs">
          {sortErr}
        </Text>
      )}
      {[...active, ...settled].map((j) => (
        <div key={j.id} className="bookJob" data-state={j.state === 'error' ? 'error' : undefined}>
          <div className="bookJob__text">
            <span className="bookJob__title">{j.folder}</span>
            <span className="bookJob__sub">
              {j.state === 'done'
                ? `done${j.via === 'ai' ? ' · read by the AI' : ''} — ${j.books.join('; ')}`
                : j.state === 'error'
                  ? j.error
                  : stateWord(j)}
            </span>
          </div>
        </div>
      ))}
    </section>
  );
}

/*
 * The file input lives inside AddBook, and the HEADER's copy of the button is
 * somewhere else entirely - so the two are joined by a function the page
 * publishes while it is mounted. A module slot rather than a context because
 * the header is not inside this page's tree at all, and a stale opener is
 * cleared on unmount rather than left pointing at a detached input.
 */
let openBookPicker: (() => void) | null = null;

function BooksHeader({
  blurb,
  onAdded,
  covers = [],
  count = 0,
  totalSeconds = 0,
  cover = null,
  onResume,
}: {
  blurb: string;
  onAdded: () => void;
  /** The shelf's own sleeves, drifting behind the title - the same treatment a
   *  playlist wears, because a shelf is identified by what is on it just as a
   *  list is. Empty on the empty page, where CoverWall draws nothing anyway. */
  covers?: readonly (string | null)[];
  count?: number;
  totalSeconds?: number;
  /** The tile's face: the book being read (favourites first), like a
   *  playlist's mosaic - the door and the room behind it, one thing. */
  cover?: string | null;
  /** Picks the book up where it was left - the shelf's one honest verb. */
  onResume?: (() => void) | null;
}) {
  /*
   * The same hero every collection wears - Liked songs, All songs, a
   * playlist - because this page IS one of those doors, and it was the only
   * one dressed differently. Same classes on purpose: the anatomy cannot
   * drift from the others if it is the others.
   */
  return (
    <header className="playlistHead songPageHead booksHead">
      <CoverWall artworks={covers} />
      <div className="playlistHead__cover" aria-hidden>
        <div className="tileSquircle playlistHead__mosaic booksHero">
          {cover ? (
            <img className="booksHero__cover" src={artSized(cover, 640) ?? cover} alt="" />
          ) : (
            <span className="booksHero__glyph">
              <BookAudio size={34} />
            </span>
          )}
        </div>
      </div>
      <div className="playlistHead__body">
        <Text tone="muted" size="xs" className="playlistHead__kicker">
          Your library
        </Text>
        <h2 className="playlistHead__name">Books</h2>
        <Text tone="muted" size="sm">
          {count > 0
            ? `${count} ${count === 1 ? 'book' : 'books'}${totalSeconds > 0 ? ` · ${formatTotal(totalSeconds)}` : ''}`
            : blurb}
        </Text>
        <div className="playlistHead__actions">
          {onResume && (
            <Button variant="solid" size="sm" onClick={onResume}>
              <Play size={15} fill="currentColor" />
              Resume
            </Button>
          )}
          <AddBook onAdded={onAdded} />
        </div>
      </div>
    </header>
  );
}

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

  // Every hook runs BEFORE the signed-out return below. Signing in or out
  // while this page is mounted re-renders it with `session` flipped, and a
  // hook that only sometimes runs is "Rendered more hooks than during the
  // previous render" - the whole page gone, not just the button. So the
  // effect sits up here and guards on session itself: no session, no input to
  // open, and a header that finds nothing published does nothing.
  const signedIn = session !== null;
  useEffect(() => {
    if (!signedIn) return;
    openBookPicker = () => input.current?.click();
    return () => {
      openBookPicker = null;
    };
  }, [signedIn]);

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
/** Where the server wants its speech model, reported by the server because it
 *  is a path only the server knows. */
let modelDir: string | null = null;

function useTranscribeStatus(): Readiness {
  const { session } = useServerSession();
  const [ready, setReady] = useState<Readiness>('asking');
  useEffect(() => {
    if (!session) return;
    sharedReadiness ??= request<{ available: boolean; toolInstalled: boolean; modelDir?: string }>(
      session.url,
      '/api/transcribe/status',
      { token: session.token },
    )
      .then((r) => {
        modelDir = r.modelDir ?? null;
        return r;
      })
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

/* --- The transcription queue ------------------------------------------------
 *
 * `/api/transcribe/jobs` is the server's live queue and the app had never once
 * asked for it. Everything the shelf said about a reading in progress came from
 * the answer to the POST that started it - a single reply, never revisited - so
 * a book could sit in the queue for an hour while its card claimed to be ready.
 *
 * ONE POLL FOR THE WHOLE PAGE. Every card wants this and so does the panel, so
 * the fetch lives here and the subscribers share it; a shelf of forty books
 * must not become forty requests.
 */

let jobsNow: TranscribeJob[] = [];
const jobListeners = new Set<() => void>();
let jobLoop: ReturnType<typeof setTimeout> | null = null;
let jobSubscribers = 0;
/** An older hub has no queue endpoint. Ask once, then stop asking for ever. */
let jobsUnsupported = false;

function sameJobs(a: TranscribeJob[], b: TranscribeJob[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.id !== y.id || x.state !== y.state || x.lines !== y.lines) return false;
  }
  return true;
}

function startJobPoll(url: string, token: string): void {
  const tick = async () => {
    try {
      const r = await request<{ jobs: TranscribeJob[] }>(url, '/api/transcribe/jobs', { token });
      const next = Array.isArray(r.jobs) ? r.jobs : [];
      if (!sameJobs(jobsNow, next)) {
        jobsNow = next;
        for (const l of jobListeners) l();
      }
    } catch (e) {
      if (e instanceof ServerError && e.status === 404) {
        jobsUnsupported = true;
        return;
      }
      // A blip. Keep the last answer and try again on the next beat rather than
      // blanking a panel somebody is watching.
    }
    // Four seconds while something is running, because that is when anybody is
    // looking; a slow beat otherwise so a queue started on another device still
    // turns up here without the page polling hard all day.
    const busy = jobsNow.some((j) => JOB_ACTIVE.has(j.state));
    jobLoop = setTimeout(() => void tick(), busy ? 4_000 : 20_000);
  };
  void tick();
}

function useTranscribeJobs(): TranscribeJob[] {
  const { session } = useServerSession();
  const [, bump] = useState(0);
  useEffect(() => {
    if (!session || jobsUnsupported) return;
    const listener = () => bump((n) => n + 1);
    jobListeners.add(listener);
    jobSubscribers += 1;
    if (jobSubscribers === 1) startJobPoll(session.url, session.token);
    return () => {
      jobListeners.delete(listener);
      jobSubscribers -= 1;
      if (jobSubscribers === 0 && jobLoop) {
        clearTimeout(jobLoop);
        jobLoop = null;
      }
    };
  }, [session]);
  return jobsNow;
}

/** What the server is doing to this file right now, in words. */
function jobWord(state: string): string {
  return state === 'queued'
    ? 'waiting its turn'
    : state === 'preparing'
      ? 'decoding the audio'
      : 'reading it';
}

/**
 * The books being transcribed, at the top of the shelf.
 *
 * WHAT THE BAR ACTUALLY MEASURES, because it would be easy to imply more than
 * the server knows: a job carries no progress figure. Whisper is handed a file
 * and answers when it is finished, so there is no fraction to report from
 * inside one reading. What IS known is how many of a book's files are done, and
 * for a sectioned book that is a real measure of the whole - chapter 3 of 42.
 *
 * A one-file book therefore gets an INDETERMINATE bar, not a fake percentage.
 * It is one long job and the only honest thing to say is that it is running.
 *
 * The panel is absent when nothing is happening. It is news, not furniture.
 */
function TranscribeProgress({ shelf }: { shelf: ShelfBook[] }) {
  const jobs = useTranscribeJobs();

  const rows = useMemo(
    () =>
      transcribeRows(
        jobs,
        shelf.map((b) => ({
          key: b.key,
          title: b.title,
          trackIds: b.tracks
            .map((t) => serverId(t.path))
            .filter((n): n is number => n !== null),
        })),
      ),
    [jobs, shelf],
  );

  if (rows.length === 0) return null;

  return (
    <section className="discoverSection bookProgress" aria-label="Books being transcribed">
      <h2 className="discoverSection__title">Being transcribed</h2>
      <ul className="bookProgress__list">
        {rows.map((r) => {
          const sectioned = r.total > 1;
          const at = Math.min(r.done + 1, r.total);
          return (
            <li key={r.key} className="bookProgress__row">
              <div className="bookProgress__line">
                <span className="bookProgress__title">{r.title}</span>
                {sectioned && (
                  <span className="bookProgress__count">
                    {r.done} of {r.total}
                  </span>
                )}
              </div>
              <ProgressBar
                value={sectioned ? r.done : undefined}
                max={sectioned ? r.total : undefined}
                indeterminate={!sectioned}
                aria-label={`Transcribing ${r.title}`}
              />
              <Text tone="muted" size="xs">
                {r.live
                  ? sectioned
                    ? `Chapter ${at} of ${r.total} — ${jobWord(r.live.state)}`
                    : `One long file — ${jobWord(r.live.state)}, and it cannot be measured from outside`
                  : null}
                {r.failed > 0 && (
                  <span className="bookProgress__failed">
                    {r.live ? ' · ' : ''}
                    {r.failed} {r.failed === 1 ? 'file' : 'files'} could not be read
                  </span>
                )}
              </Text>
            </li>
          );
        })}
      </ul>
    </section>
  );
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
  // The real queue, so this button stops guessing from a reply it got once.
  const jobs = useTranscribeJobs();

  // Only the operator can spend the box's evening, and only a book that is one
  // file has a track id worth transcribing.
  if (!session?.isAdmin || book.tracks.length !== 1) return null;
  const id = serverId(book.tracks[0]!.path);
  if (id == null) return null;

  /*
   * THE QUEUE OUTRANKS WHAT THIS BUTTON WAS TOLD. `state` only ever knew about
   * a run this card itself started, in this mount - so a reading started on
   * another device, or before the page was opened, was invisible here, and a
   * finished one never turned into "ready" without a restart.
   *
   * An errored job reads as idle rather than as a stuck "Reading it…": the
   * button becomes pressable again, and the panel above the shelf is where the
   * failure is spelled out.
   */
  const live = jobs.find((j) => j.trackId === id);
  const shown: typeof state = live
    ? JOB_ACTIVE.has(live.state)
      ? 'working'
      : live.state === 'done'
        ? 'done'
        : 'idle'
    : state;

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
      <span
        className="bookCard__readAlong"
        title={
          modelDir
            ? `The recogniser is installed but has nothing to read with. Put a whisper model in ${modelDir} — ggml-small.en.bin is the one to want.`
            : 'The recogniser is installed but has no model to read with.'
        }
      >
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
      // `queued: false` had TWO meanings and this collapsed them into one.
      // "already transcribed" really is ready; "already in the queue" means the
      // reading has not started - and calling that ready sent people into a
      // book with no words in it, which is exactly what it looked like.
      setState(r.reason === 'already transcribed' ? 'done' : 'working');
    } catch (e) {
      setState('idle');
      // The server explains itself well - no recogniser, no model, not a book.
      // Repeat it rather than replacing it with a word of our own.
      setProblem(e instanceof Error ? e.message : 'that did not go through');
    }
  };

  const label =
    // "Already read" meant the RECOGNISER had read it - and sat on the card
    // sounding like a claim about the listener's progress. Say whose reading
    // it is.
    shown === 'working' ? 'Reading it…' : shown === 'done' ? 'Read along ready' : 'Read along';

  return (
    <span className="bookCard__readAlongWrap">
      <button
        type="button"
        className="bookCard__readAlong"
        aria-label={`Transcribe ${book.title} so you can read along`}
        disabled={shown !== 'idle' || ready === 'asking'}
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

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * Right-click / long-press on a book: the shelf's own manage menu.
 *
 * The app's only deletions lived on the song table, and a book is not in it -
 * so a shelf full of finished or mis-imported books had no way out. This wears
 * the same `ContextMenu` every track already does (a right-click on the
 * desktop, a hold on touch, no pixels spent), and it IS the card rather than a
 * wrapper around it: the returned element carries `bookCard`, so the grid item
 * the shelf lays out is exactly the box it always was, admin or not.
 *
 * Removing a book is a change to the SHARED library, so it takes the rank the
 * server asks for - offered only to an admin signed into a server, the same
 * gate the import doorway and read-along wear. `removeTracks` quarantines the
 * files to the library trash rather than unlinking them, so a delete is
 * recoverable until the trash is emptied; the confirm says so and is firm
 * rather than final.
 */
function BookMenu({
  book,
  className,
  onChanged,
  children,
}: {
  book: ShelfBook;
  className?: string;
  /** Re-walk the library so the removed book leaves this device's shelf. */
  onChanged: () => void | Promise<void>;
  children: ReactNode;
}) {
  const { session } = useServerSession();
  // The wrapper is the menu's own target, so the hold resolves to itself and
  // the release is swallowed - a long-press to manage a book must not also
  // start playing it. The same hook TrackMenu uses.
  const hold = useHoldToMenu((_from, root) => root);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const [step, setStep] = useState<KeepStep | null>(null);
  // Whether every file of this book is on the device. Re-read on the vault's
  // own event, so keeping one book updates the menu of another that shares a
  // file (an omnibus, a re-release) without either being reopened.
  const [allHeld, setAllHeld] = useState(false);
  useEffect(() => {
    const look = () => setAllHeld(book.tracks.every((t) => isHeld(t.path)));
    look();
    return onOfflineChange(look);
  }, [book.tracks]);

  // The server ids behind this book's files. A local library has none (its
  // paths are not `afm://`), which also means it has no remove endpoint - so
  // an empty list is the same answer as "not a server book": no menu.
  const ids = book.tracks.map((t) => serverId(t.path)).filter((n): n is number => n !== null);
  const canManage = session?.isAdmin === true && ids.length > 0;

  /*
   * The menu opens for ANYBODY signed in now, not only the operator.
   *
   * It was gated whole on `isAdmin`, which was right when everything in it
   * spent the server's time or deleted from its disk. Keeping a book on your own
   * phone does neither - it is a thing you do to your device, and refusing it to
   * everyone in the house because they cannot also delete the book was the
   * wrong shape. The two admin verbs are gated individually below.
   */
  if (!session || ids.length === 0) return <div className={className}>{children}</div>;

  const keepWholeBook = async () => {
    if (!session || keeping) return;
    setKeeping(true);
    setProblem(null);
    try {
      const done = await keepBook(session, book.tracks, setStep);
      if (done.failed > 0) {
        setProblem(
          done.failed === book.tracks.length
            ? 'None of it would download. The hub may be unreachable.'
            : `${done.failed} of ${book.tracks.length} files did not download - try again to fill the gaps.`,
        );
      }
    } catch (e) {
      setProblem(e instanceof Error ? e.message : 'that did not go through');
    } finally {
      setKeeping(false);
      setStep(null);
    }
  };

  const releaseBook = async () => {
    if (keeping) return;
    setKeeping(true);
    try {
      for (const t of book.tracks) await unpinTrack(t.path);
      // The words go with the audio: keeping a transcript for a book whose
      // sound is no longer here holds megabytes for nothing.
      for (const id of ids) await forgetKeptTranscript(id);
    } finally {
      setKeeping(false);
    }
  };

  const retranscribe = async () => {
    if (!session || busy) return;
    setBusy(true);
    try {
      // Every file of the book: a sectioned book is transcribed per section.
      // force=1 reads it again even though a transcript exists - the door to
      // word-level clocks and fresh chapter notes for books done before them.
      for (const id of ids) {
        await request(session.url, `/api/transcribe/${id}?force=1`, {
          method: 'POST',
          token: session.token,
        });
      }
      // Drop this session's cached copies so the new reading is picked up
      // the next time the book opens, not on the next app restart.
      for (const t of book.tracks) {
        forgetTranscript(t);
        forgetChapterNotes(t);
      }
    } catch {
      // An old hub ignores the force flag and answers "already transcribed";
      // a hub with no recogniser refuses. Either way the shelf stays as it
      // was, and the transcription panel is where the queue tells its story.
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!session || busy) return;
    setBusy(true);
    setProblem(null);
    try {
      await removeTracks(session, ids);
      // The row is tombstoned server-side; this device keeps its own copy of
      // the index, so ask for the re-sync or the book lingers on the shelf.
      await onChanged();
      setConfirming(false);
    } catch (e) {
      // The server's own words: not an admin (403), or nothing left to move.
      setProblem(e instanceof Error ? e.message : 'that book could not be removed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ContextMenu
        {...hold}
        className={className}
        aria-label={`${book.title} actions`}
        content={
          <>
            {/* A book is one object twenty hours long that you are halfway
                through, so the cache's ranking - which calls the far end cold -
                is exactly wrong for it. This keeps the whole thing, words and
                all, outside that ranking. */}
            {/* The vault is a native folder, so a browser has nowhere to put a
                book. An item that silently does nothing is worse than no item. */}
            {isTauri() && (
            <MenuItem
              icon={keeping ? <Spinner size="sm" aria-label="" /> : <ArrowDownToLine size={15} />}
              onSelect={() => void keepWholeBook()}
            >
              {keeping
                ? step
                  ? step.words
                    ? 'Keeping the words…'
                    : `Keeping ${step.done} of ${step.total}…`
                  : 'Keeping…'
                : allHeld
                  ? 'Kept on this device'
                  : 'Keep on this device'}
            </MenuItem>
            )}
            {isTauri() && allHeld && !keeping && (
              <MenuItem icon={<Trash2 size={15} />} onSelect={() => void releaseBook()}>
                Remove from this device
              </MenuItem>
            )}
            {canManage && (
              <MenuItem icon={<BookOpenText size={15} />} onSelect={() => void retranscribe()}>
                Transcribe again
              </MenuItem>
            )}
            {canManage && (
              <MenuItem icon={<Trash2 size={15} />} danger onSelect={() => setConfirming(true)}>
                Delete book
              </MenuItem>
            )}
          </>
        }
      >
        {children}
      </ContextMenu>
      {confirming && (
        <Modal
          open={confirming}
          onClose={() => {
            if (!busy) setConfirming(false);
          }}
          size="sm"
          title={`Delete ${book.title}?`}
          footer={
            <>
              <Button variant="ghost" disabled={busy} onClick={() => setConfirming(false)}>
                Keep
              </Button>
              <Button variant="danger" disabled={busy} onClick={() => void remove()}>
                {busy ? 'Deleting…' : 'Delete book'}
              </Button>
            </>
          }
        >
          <Text size="sm" tone="muted">
            {book.tracks.length === 1
              ? 'This moves the book to the library trash on the server. '
              : `This moves all ${book.tracks.length} files of this book to the library trash on the server. `}
            It leaves every device on the next sync, and stays recoverable until the trash is emptied.
          </Text>
          {problem && (
            <Text as="p" size="sm" tone="danger">
              {problem}
            </Text>
          )}
        </Modal>
      )}
    </>
  );
}

export function BooksPage({ onPlay }: PluginPageProps) {
  const { session } = useServerSession();
  const { books, rescan, isFavorite, toggleFavorite } = useLibrary();
  /*
   * The header scrolls away and the app's own picks up what it was carrying -
   * the same arrangement the playlist and collection pages use, and the reason
   * `.discoverPage` is the scroller rather than an inner box.
   *
   * Books lends no Play: a shelf is a place, not a collection, and Play over it
   * would have to choose a book - which is the question the page exists to ask.
   * It lends the one control it actually offers instead.
   */
  const pageRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const root = pageRef.current;
    const mark = sentinelRef.current;
    if (!root || !mark) return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry?.isIntersecting), {
      root,
      threshold: 0,
    });
    observer.observe(mark);
    return () => observer.disconnect();
  }, [books.length === 0]);
  // The cover the header wears when the page's own head scrolls away.
  const [marks, setMarks] = useState<Map<number, { positionMs: number; updatedAt: number }>>(
    new Map(),
  );
  const refreshMarks = useCallback(() => {
    if (!session) return;
    void fetchPlayStates(session, { kind: 'book', limit: 2_000 })
      .then((states) => setMarks(new Map(states.map((s) => [s.trackId, s]))))
      .catch(() => {});
  }, [session]);
  useEffect(() => {
    refreshMarks();
  }, [refreshMarks]);

  /** Where a book stands: which chapter, and how far into it. */

  /*
   * The face of the shelf: the book you were LAST LISTENING TO.
   *
   * The bookmark ledger says which that is - the newest mark of any file of
   * any book - and it is a better answer than "a favourite" was: a shelf is
   * identified by the thing you are in the middle of, which is also the book
   * the Resume button plays. The door and the room agree. Favourites, then
   * any sleeve at all, remain the fallbacks for a shelf nobody has started.
   */
  const headerCover = useMemo(() => {
    let newest: { at: number; art: string } | null = null;
    for (const t of books) {
      if (!t.artwork) continue;
      const id = serverId(t.path);
      const mark = id != null ? marks.get(id) : undefined;
      if (mark && (!newest || mark.updatedAt > newest.at)) {
        newest = { at: mark.updatedAt, art: t.artwork };
      }
    }
    if (newest) return newest.art;
    const fav = books.find((t) => isFavorite(t.path) && t.artwork);
    return fav?.artwork ?? books.find((t) => t.artwork)?.artwork ?? null;
  }, [books, isFavorite, marks]);

    useEffect(() => {
    if (!stuck) return;
    setHeaderActions({
      title: 'Books',
      // The shelf's leading cover, the way a playlist hands up its mosaic:
      // the book being read right now. The glyph stays as the fallback for a
      // shelf with no artwork at all.
      art: headerCover,
      glyph: headerCover ? null : BookAudio,
      action: { icon: Upload, label: 'Add a book', onPress: () => openBookPicker?.() },
    });
    return () => setHeaderActions(null);
  }, [stuck, headerCover]);
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
  const isFav = (book: ShelfBook) => isFavouriteBook(book, isFavorite);
  const toggleBook = (book: ShelfBook) => {
    const on = !isFav(book);
    for (const t of book.tracks) {
      if (isFavorite(t.path) !== on) toggleFavorite(t.path);
    }
  };
  const favourites = shelf.filter(isFav);
  const rest = shelf.filter((b) => !isFav(b));

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
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const found = useMemo(() => filterBooks(shelf, query), [shelf, query]);

  if (shelf.length === 0) {
    return (
      <div ref={pageRef} className="discoverPage booksPage">
        <BooksHeader blurb="Your audiobook shelf." onAdded={rescan} />
        <div ref={sentinelRef} className="booksHead__sentinel" aria-hidden />
        <ImportDoorway />
        <Text tone="muted" size="sm">
          {/* Names only doors that EXIST. This used to send people to "Free
              books" for the LibriVox catalogue, which shipped as a default
              plugin - withdrawn 2026-08-24, so that sentence would now point at
              a page nobody has. The drop folder is the one route that needs no
              plugin at all, so it leads. */}
          No audiobooks yet. Add one you already own with the button above, or drop files into the
          library&rsquo;s <strong>Audiobooks</strong> folder and they will be shelved here with
          their chapters. Downloaders live in Settings, under their own plugins.
        </Text>
      </div>
    );
  }

  /** One card. Identical in both shelves - a favourite is the same book, in a
   *  different place on the page. */
  const card = (book: ShelfBook) => {
    const at = standing(book);
    return (
      <BookMenu key={book.key} book={book} className="bookCard" onChanged={rescan}>
        {/* Over the cover's top-left corner, not in the row of affordances
            below. It sits OUTSIDE the play button rather than inside it: a
            button within a button is invalid markup, and the press would be
            ambiguous even if it were not. */}
        <button
          type="button"
          className="bookCard__heart"
          aria-label={`${isFav(book) ? 'Remove' : 'Add'} ${book.title} ${isFav(book) ? 'from' : 'to'} favourites`}
          aria-pressed={isFav(book)}
          onClick={() => toggleBook(book)}
        >
          <Heart size={14} />
        </button>
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
              ? `${chapterFigure(book, at.index)} · ${minutes(at.positionMs)} in`
              : `${book.chapters.length} ${book.chapters.length === 1 ? 'chapter' : 'chapters'}`}
          </span>
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
      </BookMenu>
    );
  };

  // The hero's figures and its one verb: how much shelf there is, and the
  // book most recently touched - the one "pick up where you left off" means.
  const totalSeconds = useMemo(
    () => shelf.reduce((n, b) => n + b.tracks.reduce((m, t) => m + (t.duration ?? 0), 0), 0),
    [shelf],
  );
  /** "Ch 2 of 50" - the book's OWN number for the chapter, the same one the
   *  transport and the chapter list show. Front matter claims no number, so it
   *  is placed rather than numbered. */
  const chapterFigure = useCallback((book: ShelfBook, index: number) => {
    const n = chapterNumbers(book.chapters.map((c) => c.title ?? ''))[index] ?? null;
    return n === null
      ? `${index + 1} of ${book.chapters.length}`
      : `Ch ${n} of ${book.chapters.length}`;
  }, []);

  /**
   * Every book with a place kept, most recently read first.
   *
   * A bookmark per book has always been what the ledger holds - a mark is
   * written against the SECTION being read, so two books never shared a
   * position. What was missing was anywhere to see that: the hero offers one
   * verb, "Resume", pointing at the single most recent book, and the shelves
   * below are sorted by title, so a second and third book in progress were
   * scattered among everything else and reading more than one at a time felt
   * like something the app did not do.
   *
   * This is that shelf. It is derived, not stored - `standing()` already knows
   * where each book stands, so nothing new is written and a book leaves the
   * shelf by being finished, not by being tidied away.
   */
  const reading = useMemo(() => {
    const touched = (b: ShelfBook) => {
      let at = 0;
      for (const t of b.tracks) {
        const id = serverId(t.path);
        const mark = id != null ? marks.get(id) : undefined;
        if (mark && mark.updatedAt > at) at = mark.updatedAt;
      }
      return at;
    };
    return shelf
      .filter((b) => standing(b).started)
      .map((b) => ({ book: b, at: touched(b) }))
      .sort((x, y) => y.at - x.at)
      .map((r) => r.book);
  }, [shelf, marks, standing]);

  const resumeBook = useMemo(() => {
    let best: { book: ShelfBook; at: number } | null = null;
    for (const b of shelf) {
      for (const t of b.tracks) {
        const id = serverId(t.path);
        const mark = id != null ? marks.get(id) : undefined;
        if (mark && (!best || mark.updatedAt > best.at)) best = { book: b, at: mark.updatedAt };
      }
    }
    return best?.book ?? null;
  }, [shelf, marks]);

  return (
    <div ref={pageRef} className="discoverPage booksPage">
      <BooksHeader
        blurb="Your shelf — pick up where you left off."
        onAdded={rescan}
        covers={shelf.map((b) => b.cover)}
        count={shelf.length}
        totalSeconds={totalSeconds}
        cover={headerCover}
        onResume={resumeBook ? () => readBook(resumeBook) : null}
      />
      <div ref={sentinelRef} className="booksHead__sentinel" aria-hidden />

      {/* Above the shelves, because "is my book ready yet" is the question you
          came to this page with while one is being read. It shows nothing at
          all when nothing is running. */}
      {/* A REAL field, not the app's search-page doorway.
          That one hands off to the page that searches your SONGS, over a
          library books are deliberately kept out of. This filters the shelf in
          place: no navigation, no overlay, and the books stay where they are.
          Only once there is a shelf worth filtering - on four books it is
          furniture. */}
      {shelf.length > 4 && (
        <SearchField
          className="booksSearch"
          placeholder="Search your books"
          value={query}
          onValueChange={setQuery}
          aria-label="Search your books"
        />
      )}

      <TranscribeProgress shelf={shelf} />

      {/* Before the sorted shelves, because a book you are in the middle of is
          not something to go looking for alphabetically.

          Only once there are TWO. A single book in progress is already the
          hero's "Resume", and a shelf holding one card would say the same thing
          twice; this earns its place at the moment it stops being answerable by
          one button. */}
      {!searching && reading.length > 1 && (
        <section className="discoverSection">
          <h2 className="discoverSection__title">Continue reading</h2>
          <div className="booksShelf">{reading.map(card)}</div>
        </section>
      )}

      {/* SEARCHING REPLACES THE SHELVES, rather than narrowing each of them.
          Favourites, Continue reading and All books answer "what should I read
          next"; a search answers "where is the one I am thinking of", and the
          same book turning up under two headings is noise in the middle of that.
          One list, in the shelf's own order. */}
      {searching ? (
        <section className="discoverSection">
          <h2 className="discoverSection__title">
            {found.length} {found.length === 1 ? 'book' : 'books'}
          </h2>
          {found.length > 0 ? (
            <div className="booksShelf">{found.map(card)}</div>
          ) : (
            <Text tone="muted" size="sm">
              Nothing on the shelf matches “{query.trim()}”. Titles, authors and chapter names are
              all searched.
            </Text>
          )}
        </section>
      ) : (
        <>
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
        </>
      )}

      {/* The doorway's paperwork, below the books - the shelf is what the
          page is FOR, and the import ledger is worth a scroll, not the top
          third of every visit. (An EMPTY shelf still leads with it: with no
          books, getting some in is the page.) */}
      <ImportDoorway />

      {open && (
        <Modal open onClose={() => setOpen(null)} title={open.title}>
          <div className="bookChapters">
            {(() => {
              const at = standing(open);
              return open.chapters.map((c, i) => {
                const here = i === at.index && at.started;
                const row = (
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
                // Many files: each chapter is a real library track, and a
                // held chapter offers the same verbs a held song does. One
                // file: every row is the same track, and a menu repeated
                // eight times over one file says nothing - the book card's
                // own menu covers it.
                return open.singleFile ? (
                  row
                ) : (
                  <TrackMenu key={i} track={c.track}>
                    {row}
                  </TrackMenu>
                );
              });
            })()}
          </div>
        </Modal>
      )}
    </div>
  );
}
