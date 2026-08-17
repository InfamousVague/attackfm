import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, Text } from '@glacier/react';
import { Download } from '@glacier/icons';
import { isMusicImportLink, useDownloadsOptional } from '../../plugins/importsBridge.ts';

/**
 * A pasted music link, in any search field, becomes an import.
 *
 * Searching for a link never made sense - no library contains the text of a
 * URL - so the field was answering "no results" to the one input whose intent
 * is unmistakable. Here the link is taken at face value: the queue picks it up
 * and the row reports what the server is doing with it.
 *
 * Mounted next to every search box rather than built into one, because the
 * user's point was that it should not matter WHICH search they paste into.
 *
 * Renders nothing at all unless the text really is a link, so it costs the
 * ordinary search nothing.
 */
export function ImportFromSearch({ query }: { query: string }) {
  const downloads = useDownloadsOptional();
  const link = isMusicImportLink(query) ? query.trim() : null;
  const [error, setError] = useState<string | null>(null);
  // Which links this mount has already handed over. Enqueue is idempotent on
  // the server (the same URL comes back as the same job), but there is no
  // reason to ask twice per keystroke.
  const sent = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!link || !downloads) return;
    if (sent.current.has(link)) return;
    sent.current.add(link);
    setError(null);
    void Promise.resolve(downloads.enqueue(link)).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'That link could not be queued.');
    });
  }, [link, downloads]);

  if (!link) return null;

  // The importer is a plugin: switched off, or on a device with no server,
  // there is nothing to hand the link to. Say so rather than looking broken.
  if (!downloads) {
    return (
      <div className="searchImport">
        <Download size={16} />
        <Text size="sm" tone="muted">
          That looks like a music link, but the Music import plugin is not
          running. Turn it on under Settings &rarr; Plugins to download it.
        </Text>
      </div>
    );
  }

  const job = downloads.jobs.find((j) => j.url === link);
  const done = job?.state === 'done';
  const failed = job?.state === 'error';

  return (
    <div className="searchImport">
      {job && !done && !failed ? <Spinner size="sm" aria-label="" /> : <Download size={16} />}
      <div className="searchImport__body">
        <Text size="sm">
          {done
            ? `Imported ${job?.title || 'that link'}.`
            : failed
              ? `Could not import ${job?.title || 'that link'}.`
              : job
                ? `Importing ${job.title || 'that link'}…`
                : 'Importing this link…'}
        </Text>
        {job && !done && !failed && (
          <Text size="xs" tone="muted">
            {job.total
              ? `${job.completed} of ${job.total}${job.currentTrack ? ` · ${job.currentTrack}` : ''}`
              : 'Working out what this is…'}
          </Text>
        )}
        {(error || (failed && job?.error)) && (
          <Text size="xs" tone="danger">
            {error ?? job?.error}
          </Text>
        )}
      </div>
      {job && !done && !failed && (
        <Button variant="ghost" size="sm" onClick={() => downloads.cancel(job.id)}>
          Cancel
        </Button>
      )}
      {failed && (
        <Button variant="outline" size="sm" onClick={() => downloads.retry(job!.id)}>
          Retry
        </Button>
      )}
    </div>
  );
}
