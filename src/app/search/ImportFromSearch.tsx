import { useEffect, useRef, useState } from 'react';
import { Button, Spinner, Text } from '@glacier/react';
import { Download } from '@glacier/icons';
import { isMusicImportLink, useDownloadsOptional } from '../../plugins/importsBridge.ts';
import { watchIfPlaylist } from '../nav/downloadsDoor.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

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
  const t = useT();
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
      setError(err instanceof Error ? err.message : t('search.importQueueFailed'));
    });
    // A playlist takes minutes and many songs; open the Downloads pane so it
    // lands somewhere you can watch, rather than behind the search you pasted
    // into. A single or an album is done before you would look, so it stays.
    watchIfPlaylist(link);
  }, [link, downloads, t]);

  if (!link) return null;

  // The importer is a plugin: switched off, or on a device with no server,
  // there is nothing to hand the link to. Say so rather than looking broken.
  if (!downloads) {
    return (
      <div className="searchImport">
        <Download size={16} />
        <Text size="sm" tone="muted">{t('search.importPluginOff')}</Text>
      </div>
    );
  }

  const job = downloads.jobs.find((j) => j.url === link);
  const done = job?.state === 'done';
  const failed = job?.state === 'error';
  // Four states, four whole sentences. A job with no title yet is still
  // something the person can be told about, so it borrows the bell's word for
  // an unnamed link rather than leaving a hole in the middle of the sentence.
  const what = job?.title || t('notices.thatLink');
  const importLine = done
    ? t('search.imported', { title: what })
    : failed
      ? t('search.importFailed', { title: what })
      : job
        ? t('search.importing', { title: what })
        : t('search.importingLink');
  // "3 of 40" is two numbers, so they are grouped the way this locale groups
  // them; the track name, when the server has told us one, rides along in the
  // same entry so its separator can move with the language.
  const counts = { done: formatNumber(job?.completed ?? 0), total: formatNumber(job?.total ?? 0) };
  const progressLine = job?.currentTrack
    ? t('search.importProgressTrack', { ...counts, track: job.currentTrack })
    : t('search.importProgress', counts);

  return (
    <div className="searchImport">
      {job && !done && !failed ? <Spinner size="sm" aria-label="" /> : <Download size={16} />}
      <div className="searchImport__body">
        <Text size="sm">{importLine}</Text>
        {job && !done && !failed && (
          <Text size="xs" tone="muted">
            {job.total ? progressLine : t('search.importWorkingOut')}
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
          {t('common.cancel')}
        </Button>
      )}
      {failed && (
        <Button variant="outline" size="sm" onClick={() => downloads.retry(job!.id)}>
          {t('search.retryImport')}
        </Button>
      )}
    </div>
  );
}
