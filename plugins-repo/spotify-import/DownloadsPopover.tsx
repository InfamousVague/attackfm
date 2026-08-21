import { CounterBadge, IconButton, Popover, ProgressBar, Spinner, Text } from '@glacier/react';
import {
  Check,
  CheckCheck,
  Clock,
  Download,
  ListX,
  Music,
  Pause,
  Play,
  RotateCw,
  Trash2,
  TriangleAlert,
  X,
} from '@glacier/icons';
import { useDownloads } from '@attackfm/app/importsBridge';
import { useLibrary } from '@attackfm/app/library';
import { useMemo } from 'react';
import type { MusicImportJob } from './musicImport.ts';
import placeholderArt from './attack-wave.png';

/** m:ss from milliseconds. */
function fmtMs(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Case, space and curly-quote insensitive, the way the host resolves a song
 *  it only knows by name. Title alone is not enough - "Perfect" is a dozen
 *  songs - so artist is part of the key. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\u2018\u2019']/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The library's sleeve for a song named by title + artist, or null.
 *
 * Built once per library change, not per row: a playlist import is fifty rows
 * and the popover re-renders on every progress tick.
 */
function useSleeveFor(): (title: string, artist: string) => string | null {
  const { tracks } = useLibrary();
  const index = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tracks) {
      if (!t.artwork) continue;
      const k = `${norm(t.title)}\u0001${norm(t.artist)}`;
      if (!map.has(k)) map.set(k, t.artwork);
    }
    return map;
  }, [tracks]);
  return (title, artist) => index.get(`${norm(title)}\u0001${norm(artist)}`) ?? null;
}

/** The service a job came from, as the chip reads it. */
function serviceLabel(service: string): string {
  const s = service.toLowerCase();
  if (s.includes('spotify')) return 'Spotify';
  if (s.includes('deezer')) return 'Deezer';
  if (s.includes('tidal')) return 'Tidal';
  if (s.includes('apple')) return 'Apple Music';
  if (s.includes('qobuz')) return 'Qobuz';
  if (s.includes('youtube') || s.includes('yt')) return 'YT Music';
  return service || '';
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

/** The job's state, worn as a badge on its artwork corner - the same place
 *  every other card in the app carries its verdict, so a glance down the
 *  queue reads spinner / check / cross with no words at all. */
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

/** One import in the popover: art wearing its state, title, icon-chip counts,
 *  progress, and controls. */
function JobCard({ job }: { job: MusicImportJob }) {
  const { remove, retry, cancel } = useDownloads();
  const sleeveFor = useSleeveFor();
  const active = job.state === 'queued' || job.state === 'downloading';
  const total = job.total ?? 0;
  const service = serviceLabel(job.service);
  // "LOSSLESS" is the server's default and says nothing; anything else is
  // worth a chip because it was chosen.
  const quality = job.quality && job.quality.toUpperCase() !== 'LOSSLESS' ? job.quality : null;
  return (
    <li className="dlCard">
      <span className="dlCard__artWrap">
        <img className="dlCard__art" src={job.artworkUrl ?? placeholderArt} alt="" loading="lazy" />
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
          {service && (
            <span className="dlChip dlChip--source" title={`From ${service}`}>
              {service}
            </span>
          )}
          {quality && (
            <span className="dlChip" title="Quality">
              {quality}
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
        {job.tracks.length > 0 && (
          <ol className="dlTracks">
            {job.tracks.map((title, i) => {
              const st = trackState(job, i);
              // What the embed knew before the download: artist and length.
              // Absent on a server older than the field, and the row still
              // draws its name exactly as it always did.
              const rich = job.items?.[i];
              const artist = rich?.artist ?? '';
              // Once a song is in the library its own sleeve takes the icon's
              // seat - the list turns into the record as it lands.
              const sleeve = st === 'done' && artist ? sleeveFor(title, artist) : null;
              return (
                <li key={i} className={`dlTrack dlTrack--${st}`}>
                  <span className="dlTrack__icon">
                    {sleeve ? (
                      <img className="dlTrack__thumb" src={sleeve} alt="" loading="lazy" />
                    ) : (
                      <TrackIcon state={st} />
                    )}
                  </span>
                  <span className="dlTrack__text">
                    <span className="dlTrack__title">{title}</span>
                    {artist && <span className="dlTrack__artist">{artist}</span>}
                  </span>
                  {rich?.durationMs ? <span className="dlTrack__dur">{fmtMs(rich.durationMs)}</span> : null}
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
          <span className="dlPanel__title">
            <Download size={14} /> Downloads
            {active.length > 0 && (
              <CounterBadge count={active.length} tone="accent" size="sm" />
            )}
          </span>
          <div className="dlPanel__actions">
            {active.length > 0 &&
              (paused ? (
                <IconButton variant="ghost" size="sm" aria-label="Resume downloads" title="Resume" onClick={() => setPaused(false)}>
                  <Play size={15} />
                </IconButton>
              ) : (
                <IconButton variant="ghost" size="sm" aria-label="Pause downloads" title="Pause" onClick={() => setPaused(true)}>
                  <Pause size={15} />
                </IconButton>
              ))}
            {hasFinished && (
              <IconButton variant="ghost" size="sm" aria-label="Clear finished" title="Clear finished" onClick={clearFinished}>
                <ListX size={15} />
              </IconButton>
            )}
          </div>
        </div>
        {paused && active.length > 0 && (
          <Text tone="muted" size="xs" className="dlPanel__note">
            <Pause size={11} /> Paused — active downloads finish, new ones wait.
          </Text>
        )}
        {jobs.length === 0 ? (
          <div className="dlPanel__empty">
            <span className="dlPanel__emptyGlyph" aria-hidden>
              <Download size={18} />
            </span>
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
