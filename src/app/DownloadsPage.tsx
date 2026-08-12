import { Button, ProgressBar, Spinner } from '@glacier/react';
import { Check, CheckCheck, Clock, ListX, Music, Pause, Play, RotateCcw, Trash2, TriangleAlert, X } from '@glacier/icons';
import { useDownloadsOptional, type MusicImportJob } from '../plugins/importsBridge.ts';
import { EmptyArt } from './EmptyArt.tsx';
import { artSized } from './server.ts';
import { useArtLoad } from './artLoad.ts';
import placeholderArt from '../assets/attack-wave.png';

/**
 * The Downloads tab: the import queue as a full page. It reads the shared
 * downloads bridge (filled by the importer plugin), so it stands empty and
 * points at Plugins when no importer is on, and otherwise lists every job with
 * its live state and the controls to pause, retry, cancel, or clear.
 */

/** One song's place in its album/playlist import, derived the same way the
 *  importer popover derives it - the two surfaces must never disagree. */
type TrackState = 'done' | 'downloading' | 'error' | 'queued';

function trackState(job: MusicImportJob, index: number): TrackState {
  if (job.state === 'done') return 'done';
  if (index < job.completed) return 'done';
  if (job.currentIndex === index) return job.state === 'error' ? 'error' : 'downloading';
  return 'queued';
}

function TrackIcon({ state }: { state: TrackState }) {
  if (state === 'done') return <Check size={13} />;
  if (state === 'downloading') return <Spinner size="sm" aria-label="" />;
  if (state === 'error') return <X size={13} />;
  return <span className="dlTrack__dot" />;
}

/** The job's state as a badge on its artwork corner - spinner, check or
 *  cross where every other card in the app wears its verdict, no words. */
function StateBadge({ job }: { job: MusicImportJob }) {
  if (job.state === 'done')
    return (
      <span className="dlCard__badge" data-state="done" title="Done">
        <Check size={11} />
      </span>
    );
  if (job.state === 'error')
    return (
      <span className="dlCard__badge" data-state="error" title="Failed">
        <X size={11} />
      </span>
    );
  if (job.state === 'downloading')
    return (
      <span className="dlCard__badge" data-state="downloading" title="Downloading">
        <Spinner size="sm" aria-label="Downloading" />
      </span>
    );
  return (
    <span className="dlCard__badge" data-state="queued" title="Queued">
      <Clock size={11} />
    </span>
  );
}

function JobCard({
  job,
  onRemove,
  onRetry,
  onCancel,
}: {
  job: MusicImportJob;
  onRemove: () => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const active = job.state === 'queued' || job.state === 'downloading';
  const total = job.total ?? 0;
  // The card draws its cover at thumb size, so ask for the 160 variant; the
  // skeleton shimmer holds the square while it downloads alongside the songs.
  const artSrc = artSized(job.artworkUrl, 160) ?? placeholderArt;
  const art = useArtLoad(artSrc, 'dlCard__art');
  return (
    <li className="dlCard">
      <span className="dlCard__artWrap">
        <img {...art} src={artSrc} alt="" loading="lazy" />
        <StateBadge job={job} />
      </span>
      <div className="dlCard__body">
        <span className="dlCard__title">{job.title}</span>
        <span className="dlCard__meta">
          <span className="dlCard__sub">{job.subtitle ?? 'Music link'}</span>
          {total > 0 && (
            <span className="dlChip" title={`${job.completed} of ${total} songs`}>
              <Music size={11} />
              {job.completed}/{total}
            </span>
          )}
          {job.state === 'done' && !!job.skipped && (
            <span className="dlChip" title={`${job.skipped} already in library`}>
              <CheckCheck size={11} />
              {job.skipped}
            </span>
          )}
        </span>
        {active && (
          <ProgressBar
            className="dlCard__bar"
            value={job.completed}
            max={total || 1}
            indeterminate={total === 0}
            tone="accent"
            size="sm"
            aria-label="Download progress"
          />
        )}
        {job.state === 'downloading' && job.currentTrack && job.tracks.length === 0 && (
          <span className="dlCard__track">
            <Spinner size="sm" aria-label="" /> {job.currentTrack}
          </span>
        )}
        {job.state === 'error' && job.error && (
          <span className="dlCard__error">
            <TriangleAlert size={11} /> {job.error}
          </span>
        )}
        {/* The whole album/playlist, song by song - what has landed, what is
            coming down right now, what still waits - visible on the page for
            active AND finished jobs alike, matching the importer popover. */}
        {job.tracks.length > 0 && (
          <ol className="dlTracks">
            {job.tracks.map((title, i) => {
              const st = trackState(job, i);
              return (
                <li key={i} className={`dlTrack dlTrack--${st}`}>
                  <span className="dlTrack__icon">
                    <TrackIcon state={st} />
                  </span>
                  <span className="dlTrack__title">{title}</span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
      <div className="dlCard__actions">
        {job.state === 'error' && (
          <button type="button" className="dlCard__act" aria-label="Retry" title="Retry" onClick={onRetry}>
            <RotateCcw size={16} />
          </button>
        )}
        {active ? (
          <button type="button" className="dlCard__act" aria-label="Cancel" title="Cancel" onClick={onCancel}>
            <X size={16} />
          </button>
        ) : (
          <button type="button" className="dlCard__act" aria-label="Remove" title="Remove" onClick={onRemove}>
            <Trash2 size={16} />
          </button>
        )}
      </div>
    </li>
  );
}

export function DownloadsPage() {
  const downloads = useDownloadsOptional();

  if (!downloads) {
    return (
      <div className="homePage downloadsPage">
        <div className="emptyState emptyState--tall">
          <EmptyArt name="downloads" />
          <p className="downloadsEmpty">
            Turn on <strong>Music import</strong> in Settings → Plugins to download songs into your
            library.
          </p>
        </div>
      </div>
    );
  }

  const { jobs, paused, setPaused, clearFinished, remove, retry, cancel } = downloads;
  const hasFinished = jobs.some((j) => j.state === 'done' || j.state === 'error');

  return (
    <div className="homePage downloadsPage">
      {/* The page's name sits in the app header, like Library's; this row is
          just the queue's controls. */}
      <header className="libraryHead downloadsHead">
        <div className="downloadsHead__actions">
          <Button variant="soft" size="sm" onClick={() => setPaused(!paused)}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
            <span>{paused ? 'Resume' : 'Pause'}</span>
          </Button>
          {hasFinished && (
            <Button variant="ghost" size="sm" onClick={clearFinished} title="Clear finished">
              <ListX size={15} />
              <span>Clear finished</span>
            </Button>
          )}
        </div>
      </header>

      {jobs.length === 0 ? (
        <div className="emptyState emptyState--tall">
          <EmptyArt name="downloads" />
          <p className="downloadsEmpty">
            Nothing in the queue. Add songs from <strong>Discovery</strong>, or paste a music link
            into search.
          </p>
        </div>
      ) : (
        <ul className="dlList downloadsList">
          {jobs.map((j) => (
            <JobCard
              key={j.id}
              job={j}
              onRemove={() => remove(j.id)}
              onRetry={() => retry(j.id)}
              onCancel={() => cancel(j.id)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
