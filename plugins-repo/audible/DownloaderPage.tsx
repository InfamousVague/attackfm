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
import {
  audibleImport,
  audibleJobs,
  audibleLibrary,
  audibleStatus,
  type AudibleBook,
  type AudibleJob,
} from './audibleAccount.ts';

/**
 * The audiobook downloader: where books are ACQUIRED (reading them is the core
 * Books shelf's job). Two wells - the books you own on Audible, once the account
 * is connected in Settings, and the public domain on LibriVox - both landing in
 * the same library as ordinary `kind = 'book'` files.
 */

const AUD_LABEL: Record<AudibleJob['state'], string> = {
  queued: 'Queued',
  downloading: 'Downloading…',
  decrypting: 'Decrypting…',
  filing: 'Adding…',
  done: 'Added',
  error: 'Failed',
};

function minutes(min: number | null): string {
  if (!min) return '';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}

export function DownloaderPage(_props: PluginPageProps) {
  const { session } = useServerSession();
  const { rescan } = useLibrary();

  // --- Audible ---------------------------------------------------------------
  const [audConnected, setAudConnected] = useState<boolean | null>(null);
  const [audBooks, setAudBooks] = useState<AudibleBook[] | null>(null);
  const [audLoading, setAudLoading] = useState(false);
  const [audJobs, setAudJobs] = useState<AudibleJob[]>([]);
  const [audNote, setAudNote] = useState<string | null>(null);

  const loadAudible = useCallback(async () => {
    if (!session) return;
    setAudLoading(true);
    try {
      const status = await audibleStatus(session);
      setAudConnected(status.connected);
      if (status.connected) {
        const lib = await audibleLibrary(session);
        setAudBooks(lib.books);
      }
    } catch {
      setAudConnected(false);
    } finally {
      setAudLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void loadAudible();
  }, [loadAudible]);

  const audActive = audJobs.some(
    (j) => j.state !== 'done' && j.state !== 'error',
  );
  useEffect(() => {
    if (!session || audConnected !== true) return;
    let live = true;
    const poll = () => {
      void audibleJobs(session)
        .then((js) => {
          if (!live) return;
          setAudJobs((prev) => {
            const wasActive = prev.some((p) => p.state !== 'done' && p.state !== 'error');
            const isActive = js.some((p) => p.state !== 'done' && p.state !== 'error');
            // A finished download pulls the library and reloads ownership.
            if (wasActive && !isActive) {
              void rescan();
              void loadAudible();
            }
            return js;
          });
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, audActive ? 3_000 : 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, audConnected, audActive, rescan, loadAudible]);

  const audJobFor = (asin: string) => audJobs.find((j) => j.asin === asin);

  const pullAudible = (book: AudibleBook) => {
    if (!session) return;
    setAudNote(null);
    void audibleImport(session, book)
      .then((job) => setAudJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]))
      .catch((e) => setAudNote(e instanceof Error ? e.message : 'Could not queue that book.'));
  };

  // --- LibriVox --------------------------------------------------------------
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CatalogBook[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [missing, setMissing] = useState(false);
  const [lvNote, setLvNote] = useState<string | null>(null);
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

  const [lvJobs, setLvJobs] = useState<BookJob[]>([]);
  const lvActive = lvJobs.some((j) => j.state === 'queued' || j.state === 'downloading');
  useEffect(() => {
    if (!session) return;
    let live = true;
    const poll = () => {
      void bookJobs(session)
        .then((js) => {
          if (!live) return;
          setLvJobs((prev) => {
            const was = prev.some((p) => p.state === 'queued' || p.state === 'downloading');
            const is = js.some((p) => p.state === 'queued' || p.state === 'downloading');
            if (was && !is) void rescan();
            return js;
          });
        })
        .catch(() => {});
    };
    poll();
    const timer = window.setInterval(poll, lvActive ? 3_000 : 30_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, lvActive, rescan]);

  const lvJobFor = (bookId: number) => lvJobs.find((j) => j.bookId === bookId);
  const pullLibriVox = (book: CatalogBook) => {
    if (!session) return;
    setLvNote(null);
    void importBook(session, book.id)
      .then((job) => setLvJobs((prev) => [job, ...prev.filter((j) => j.id !== job.id)]))
      .catch((e) => setLvNote(e instanceof Error ? e.message : 'Could not queue that book.'));
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
          Books you download land in your library and show up under Books.
        </Text>
      </div>

      {/* Your Audible library. */}
      <div className="prefsSection">
        <Text size="md" className="pageHeading">
          Your Audible library
        </Text>
        {audConnected === false ? (
          <Text tone="muted" size="sm">
            Connect your Audible account in Settings → Audible to pull in the books you own.
          </Text>
        ) : audLoading && !audBooks ? (
          <div className="booksSearching">
            <Spinner /> <Text tone="muted" size="sm">Reading your library…</Text>
          </div>
        ) : audBooks && audBooks.length > 0 ? (
          <>
            {audNote && (
              <Text tone="danger" size="sm">
                {audNote}
              </Text>
            )}
            <div className="bookResults">
              {audBooks.map((book) => {
                const job = audJobFor(book.asin);
                const owned = book.ownedLocally || job?.state === 'done';
                const busy = job && job.state !== 'done' && job.state !== 'error';
                const failed = job?.state === 'error';
                return (
                  <div key={book.asin} className="bookResult">
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
                        {book.runtimeMin ? ` · ${minutes(book.runtimeMin)}` : ''}
                      </Text>
                      {failed && (
                        <Text tone="danger" size="xs">
                          {job?.error ?? 'Failed'}
                        </Text>
                      )}
                    </div>
                    <Button
                      variant={owned ? 'ghost' : 'outline'}
                      size="sm"
                      disabled={owned || !!busy}
                      onClick={() => pullAudible(book)}
                    >
                      {owned ? (
                        <>
                          <Check size={15} /> In library
                        </>
                      ) : busy ? (
                        AUD_LABEL[job!.state]
                      ) : failed ? (
                        'Retry'
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
          </>
        ) : audBooks ? (
          <Text tone="muted" size="sm">
            No books in your Audible library yet.
          </Text>
        ) : (
          <div className="booksSearching">
            <Spinner /> <Text tone="muted" size="sm">Checking Audible…</Text>
          </div>
        )}
      </div>

      {/* The LibriVox public-domain catalogue. */}
      <div className="prefsSection">
        <Text size="md" className="pageHeading">
          LibriVox — free & public domain
        </Text>
        <div className="booksSearchRow">
          <Search size={16} aria-hidden />
          <Input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder="Search a title or an author"
            aria-label="Search the LibriVox catalogue"
          />
        </div>

        {missing && (
          <Text tone="muted" size="sm">
            This server is too old for the audiobook catalogue — update the hub.
          </Text>
        )}
        {lvNote && (
          <Text tone="danger" size="sm">
            {lvNote}
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
              const job = lvJobFor(book.id);
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
                    onClick={() => pullLibriVox(book)}
                  >
                    {done ? (
                      <>
                        <Check size={15} /> Added
                      </>
                    ) : busy ? (
                      `${job!.completed}/${job!.total}`
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
