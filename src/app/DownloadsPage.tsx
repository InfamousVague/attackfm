import { Button, ProgressBar, Spinner } from '@glacier/react';
import { Check, Pause, Play, RotateCcw, Trash2, X } from '@glacier/icons';
import { useDownloadsOptional, type MusicImportJob } from '../plugins/importsBridge.ts';
import { EmptyArt } from './EmptyArt.tsx';
import placeholderArt from '../assets/attack-wave.png';

/**
 * The Downloads tab: the import queue as a full page. It reads the shared
 * downloads bridge (filled by the importer plugin), so it stands empty and
 * points at Plugins when no importer is on, and otherwise lists every job with
 * its live state and the controls to pause, retry, cancel, or clear.
 */

function stateLabel(job: MusicImportJob): string {
  switch (job.state) {
    case 'done':
      return 'Done';
    case 'downloading':
      return 'Downloading';
    case 'error':
      return 'Failed';
    default:
      return 'Queued';
  }
}

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
  return (
    <li className="dlCard">
      <img className="dlCard__art" src={job.artworkUrl ?? placeholderArt} alt="" loading="lazy" />
      <div className="dlCard__body">
        <div className="dlCard__top">
          <span className="dlCard__title">{job.title}</span>
          <span className={`dlCard__state dlCard__state--${job.state}`}>{stateLabel(job)}</span>
        </div>
        <span className="dlCard__sub">
          {job.subtitle ?? 'Music link'}
          {total > 0 ? ` · ${job.completed}/${total}` : ''}
          {job.state === 'done' && job.skipped ? ` · ${job.skipped} already in library` : ''}
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
        {job.state === 'downloading' && job.currentTrack && (
          <span className="dlCard__track">{job.currentTrack}</span>
        )}
        {job.state === 'error' && job.error && <span className="dlCard__error">{job.error}</span>}
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
          <button type="button" className="dlCard__act" aria-label="Retry" onClick={onRetry}>
            <RotateCcw size={16} />
          </button>
        )}
        {active ? (
          <button type="button" className="dlCard__act" aria-label="Cancel" onClick={onCancel}>
            <X size={16} />
          </button>
        ) : (
          <button type="button" className="dlCard__act" aria-label="Remove" onClick={onRemove}>
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
            <Button variant="ghost" size="sm" onClick={clearFinished}>
              Clear finished
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
