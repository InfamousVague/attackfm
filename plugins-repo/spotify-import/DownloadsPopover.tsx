import { CounterBadge, IconButton, Popover, ProgressBar, Spinner, Text } from '@glacier/react';
import { Check, Download, Pause, Play, RotateCw, Trash2, X } from '@glacier/icons';
import { useDownloads } from '@attackfm/app/importsBridge';
import type { MusicImportJob } from './musicImport.ts';
import placeholderArt from './attack-wave.png';

function stateLabel(job: MusicImportJob): string {
  switch (job.state) {
    case 'queued':
      return 'Queued';
    case 'downloading':
      return 'Downloading';
    case 'done':
      return 'Done';
    case 'error':
      return 'Failed';
    default:
      return job.state;
  }
}

type TrackState = 'done' | 'downloading' | 'error' | 'queued';

/** Per-song state, derived from the job's completed count and current index. */
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

/** One import in the popover: art, title, progress, live track, and controls. */
function JobCard({ job }: { job: MusicImportJob }) {
  const { remove, retry, cancel } = useDownloads();
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
          <IconButton variant="ghost" size="sm" aria-label="Retry" onClick={() => retry(job.id)}>
            <RotateCw size={15} />
          </IconButton>
        )}
        {active ? (
          <IconButton variant="ghost" size="sm" aria-label="Cancel" onClick={() => cancel(job.id)}>
            <X size={15} />
          </IconButton>
        ) : (
          <IconButton variant="ghost" size="sm" aria-label="Remove" onClick={() => remove(job.id)}>
            <Trash2 size={15} />
          </IconButton>
        )}
      </div>
    </li>
  );
}

/** The title-bar downloads button: a badge-counted trigger opening the queue popover. */
export function DownloadsButton() {
  const { jobs, active, paused, setPaused, clearFinished } = useDownloads();
  const hasFinished = jobs.some((j) => j.state === 'done' || j.state === 'error');
  return (
    <Popover
      placement="bottom-end"
      trigger={
        <IconButton className="dlTrigger" variant="ghost" size="sm" aria-label="Downloads">
          <Download size={16} />
          {active.length > 0 && (
            <CounterBadge className="dlTrigger__badge" count={active.length} tone="accent" size="sm" />
          )}
        </IconButton>
      }
    >
      <div className="dlPanel">
        <div className="dlPanel__head">
          <span className="dlPanel__title">Downloads</span>
          <div className="dlPanel__actions">
            {active.length > 0 &&
              (paused ? (
                <IconButton variant="ghost" size="sm" aria-label="Resume downloads" onClick={() => setPaused(false)}>
                  <Play size={15} />
                </IconButton>
              ) : (
                <IconButton variant="ghost" size="sm" aria-label="Pause downloads" onClick={() => setPaused(true)}>
                  <Pause size={15} />
                </IconButton>
              ))}
            {hasFinished && (
              <button type="button" className="dlPanel__clear" onClick={clearFinished}>
                Clear finished
              </button>
            )}
          </div>
        </div>
        {paused && active.length > 0 && (
          <Text tone="muted" size="xs">
            Paused — active downloads finish, new ones wait.
          </Text>
        )}
        {jobs.length === 0 ? (
          <div className="dlPanel__empty">
            <Text tone="muted" size="sm">
              Paste a Spotify link into search to queue a download.
            </Text>
          </div>
        ) : (
          <ul className="dlList">
            {jobs.map((job) => (
              <JobCard key={job.id} job={job} />
            ))}
          </ul>
        )}
      </div>
    </Popover>
  );
}
