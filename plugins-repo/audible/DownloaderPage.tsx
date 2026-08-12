import { Button, Spinner, Text } from '@glacier/react';
import { BookHeadphones, Check, Plus } from '@glacier/icons';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useServerSession } from '@attackfm/app/serverSession';
import type { PluginPageProps } from '../../src/plugins/types.ts';
import { audibleLibrary, audibleStatus, type AudibleBook, type AudibleJob } from './audibleAccount.ts';
import { useAudibleQueue } from './queue.tsx';

/**
 * The Audible downloader page: the books you OWN on Audible, pulled into the
 * library. Reading them is the core Books shelf's job; this only fetches. Free,
 * public-domain books are a separate plugin (LibriVox); this one is Audible
 * alone. Once the account is connected in Settings, your library lists here with
 * an Add button per book that downloads, decrypts, and files it under Books.
 *
 * The queue itself is not drawn here - the Downloads page shows every book in
 * flight beside everything else coming down. This page keeps only the mark on
 * the row you tapped, so Add turns into a stage and then a tick in place.
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
  const { jobFor, busy, pull: pullBook } = useAudibleQueue();

  const [connected, setConnected] = useState<boolean | null>(null);
  const [audBooks, setAudBooks] = useState<AudibleBook[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const status = await audibleStatus(session);
      setConnected(status.connected);
      if (status.connected) setAudBooks((await audibleLibrary(session)).books);
    } catch {
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // The list carries an "already yours" mark per book, so it is stale the
  // moment the queue drains - reload it then, and only then.
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) void load();
    wasBusy.current = busy;
  }, [busy, load]);

  const pull = (book: AudibleBook) => {
    if (!session) return;
    setNote(null);
    void pullBook(book).catch((e) =>
      setNote(e instanceof Error ? e.message : 'Could not queue that book.'),
    );
  };

  if (!session) {
    return (
      <div className="discoverPage">
        <Text tone="muted" size="sm">
          Audible downloads run on your server — connect one under Settings → Server first.
        </Text>
      </div>
    );
  }

  return (
    <div className="discoverPage">
      <div className="prefsSection">
        <Text size="lg" className="pageHeading">
          Your Audible library
        </Text>
        <Text tone="muted" size="sm">
          The books you own, pulled into your library and shelved under Books.
        </Text>
      </div>

      {connected === false ? (
        <div className="prefsSection">
          <Text tone="muted" size="sm">
            Connect your Audible account in Settings → Audible to see the books you own here.
          </Text>
        </div>
      ) : loading && !audBooks ? (
        <div className="booksSearching">
          <Spinner /> <Text tone="muted" size="sm">Reading your library…</Text>
        </div>
      ) : audBooks && audBooks.length > 0 ? (
        <div className="prefsSection">
          {note && (
            <Text tone="danger" size="sm">
              {note}
            </Text>
          )}
          <div className="bookResults">
            {audBooks.map((book) => {
              const job = jobFor(book.asin);
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
                    onClick={() => pull(book)}
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
        </div>
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
  );
}
