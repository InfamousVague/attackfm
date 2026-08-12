import { Button, Input, Spinner, Text } from '@glacier/react';
import { BookAudio, Check, Plus, Search } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { useServerSession } from '@attackfm/app/serverSession';
import type { PluginPageProps } from '../../src/plugins/types.ts';
import { searchBooks, MissingEndpointError, type CatalogBook } from './api.ts';
import { useBookQueue } from './queue.tsx';

/**
 * The LibriVox catalogue: search the public domain and pull a book in. Free,
 * no account - volunteers reading out-of-copyright books. Whatever it saves
 * lands in the library as `kind = 'book'` and shows on the core Books shelf.
 *
 * A catalogue, and only a catalogue. What is coming down is the Downloads
 * page's job - this page keeps just enough of the queue to mark the row you
 * tapped, so "Add" turns into a count and then a tick without you leaving.
 */
export function LibriVoxPage(_props: PluginPageProps) {
  const { session } = useServerSession();
  const { jobFor, pull: pullBook } = useBookQueue();

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

  const pull = (book: CatalogBook) => {
    if (!session) return;
    setNote(null);
    void pullBook(book.id).catch((e) =>
      setNote(e instanceof Error ? e.message : 'Could not queue that book.'),
    );
  };

  if (!session) {
    return (
      <div className="discoverPage">
        <Text tone="muted" size="sm">
          LibriVox downloads run on your server — connect one under Settings → Server first.
        </Text>
      </div>
    );
  }

  return (
    <div className="discoverPage">
      <div className="prefsSection">
        <Text size="lg" className="pageHeading">
          LibriVox — free audiobooks
        </Text>
        <Text tone="muted" size="sm">
          Public-domain books read by volunteers. Anything you add lands on your Books shelf.
        </Text>
      </div>

      <div className="prefsSection">
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
              const job = jobFor(book.id);
              const done = job?.state === 'done';
              const busy = job?.state === 'queued' || job?.state === 'downloading';
              return (
                <div key={book.id} className="bookResult">
                  {book.cover ? (
                    <img className="bookResultArt" src={book.cover} alt="" loading="lazy" />
                  ) : (
                    <span className="bookResultArt" aria-hidden>
                      <BookAudio size={20} />
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
