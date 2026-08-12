import { Button, Input, Spinner, Text } from '@glacier/react';
import { BookHeadphones, Check, Plus, Search } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLibrary } from '@attackfm/app/library';
import { useServerSession } from '@attackfm/app/serverSession';
import type { PluginPageProps } from '../../src/plugins/types.ts';
import {
  bookJobs,
  importBook,
  searchBooks,
  MissingEndpointError,
  type BookJob,
  type CatalogBook,
} from './libriVoxApi.ts';

/**
 * The audiobook downloader: where books are ACQUIRED. Reading them is the core
 * Books shelf's job; this page only fetches. Two wells feed it - the books you
 * own on Audible (once the account is connected in Settings) and the public
 * domain, read by volunteers, on LibriVox - and both land in the same library
 * as ordinary `kind = 'book'` files. For now the working well is LibriVox; the
 * Audible one lights up the moment an account is connected.
 */
export function DownloaderPage(_props: PluginPageProps) {
  const { session } = useServerSession();
  const { rescan } = useLibrary();

  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogBook[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [missing, setMissing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const debounce = useRef<number | undefined>(undefined);

  // The debounced catalogue search: two characters before it asks, and only
  // the last keystroke in a 450ms lull actually reaches the server.
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

  // The download queue, polled only while something is moving; when a job
  // crosses the line the library is pulled in behind it so the new book lands
  // on the shelf without waiting for the next scheduled sync.
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
            const wasActive = prev.some((p) => p.state === 'queued' || p.state === 'downloading');
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

  const jobForBook = (bookId: number) => jobs.find((j) => j.bookId === bookId);

  const pull = (book: CatalogBook) => {
    if (!session) return;
    setNote(null);
    void importBook(session, book.id)
      .then((job) => setJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]))
      .catch((e) => setNote(e instanceof Error ? e.message : 'Could not queue that book.'));
  };

  if (!session) {
    return (
      <div className="discoverPage">
        <Text tone="muted" size="sm">
          The downloader runs on your server — connect one under Settings → Server first.
        </Text>
      </div>
    );
  }

  return (
    <div className="discoverPage">
      <div className="prefsSection">
        <Text size="lg" className="pageHeading">
          Get audiobooks
        </Text>
        <Text tone="muted" size="sm">
          Books you download land in your library and show up under Books. Your own Audible books
          come from a connected account — set that up in Settings → Audible. Below is the LibriVox
          public-domain catalogue, free to pull any time.
        </Text>
      </div>

      {/* The active/recent downloads, whatever their source. */}
      {jobs.length > 0 && (
        <div className="prefsSection">
          {jobs.slice(0, 6).map((job) => (
            <div key={job.id} className="bookJob" data-state={job.state}>
              {job.cover ? (
                <img className="bookJobArt" src={job.cover} alt="" loading="lazy" />
              ) : (
                <span className="bookJobArt" aria-hidden />
              )}
              <div className="bookJobCopy">
                <Text size="sm">{job.title}</Text>
                <Text tone="muted" size="xs">
                  {job.state === 'error'
                    ? (job.error ?? 'Failed')
                    : job.state === 'done'
                      ? 'Added to your library'
                      : job.state === 'queued'
                        ? 'Queued'
                        : `${job.completed} of ${job.total}${job.currentSection ? ` · ${job.currentSection}` : ''}`}
                </Text>
                {(job.state === 'downloading' || job.state === 'queued') && job.total > 0 && (
                  <span className="bookJobBar">
                    <span
                      className="bookJobBarFill"
                      style={{ width: `${Math.round((job.completed / job.total) * 100)}%` }}
                    />
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The LibriVox catalogue search. */}
      <div className="prefsSection">
        <div className="booksSearchRow">
          <Search size={16} aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search LibriVox — a title or an author"
            aria-label="Search the audiobook catalogue"
          />
        </div>

        {missing && (
          <Text tone="muted" size="sm">
            This server is too old for the audiobook catalogue — update the hub.
          </Text>
        )}
        {note && (
          <Text tone="danger" size="sm">
            {note}
          </Text>
        )}
        {searching && (
          <div className="booksSearching">
            <Spinner /> <Text tone="muted" size="sm">Searching…</Text>
          </div>
        )}
        {results && results.length === 0 && !searching && (
          <Text className="booksEmpty" tone="muted" size="sm">
            Nothing found — try an author, or fewer words.
          </Text>
        )}
        {results && results.length > 0 && (
          <div className="bookResults">
            {results.map((book) => {
              const job = jobForBook(book.id);
              const done = job?.state === 'done';
              const busy = job?.state === 'queued' || job?.state === 'downloading';
              return (
                <div key={book.id} className="bookResult">
                  {book.cover ? (
                    <img className="bookResultArt" src={book.cover} alt="" loading="lazy" />
                  ) : (
                    <span className="bookResultArt" aria-hidden>
                      <BookHeadphones size={20} />
                    </span>
                  )}
                  <div className="bookResultCopy">
                    <Text size="sm">{book.title}</Text>
                    <Text tone="muted" size="xs">
                      {book.author}
                      {book.sections ? ` · ${book.sections} sections` : ''}
                      {book.totaltime ? ` · ${book.totaltime}` : ''}
                    </Text>
                  </div>
                  <Button
                    variant={done ? 'ghost' : 'outline'}
                    size="sm"
                    disabled={busy || done}
                    onClick={() => pull(book)}
                  >
                    {done ? (
                      <>
                        <Check size={15} /> Added
                      </>
                    ) : busy ? (
                      '…'
                    ) : (
                      <>
                        <Plus size={15} /> Add
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
