import { useState } from 'react';
import { Button, ProgressBar, Spinner } from '@glacier/react';
import {
  Check,
  CheckCheck,
  ChevronDown,
  Clock,
  Disc3,
  Download,
  ListMusic,
  ListX,
  Music,
  Pause,
  Play,
  RotateCcw,
  Trash2,
  TriangleAlert,
  User,
  X,
} from '@glacier/icons';
import { useDownloadsOptional, type MusicImportJob } from '../plugins/importsBridge.ts';
import { EmptyArt } from './EmptyArt.tsx';
import { artSized } from './server.ts';
import { useArtLoad } from './artLoad.ts';
import placeholderArt from '../assets/attack-wave.png';

/**
 * The Downloads page: the import queue as a destination, not a popover.
 *
 * A queue is something you WATCH - fifty songs arriving over ten minutes - and
 * a panel that closes when you look away is the wrong container for it. The
 * page reads the shared downloads bridge (filled by the importer plugin), so
 * it stands empty and points at Plugins when no importer is on.
 *
 * Three things carry the design. A status strip answers "what is happening"
 * in one glance, before any card is read. The queue is then SPLIT by state -
 * what is coming down now, what waits, what is finished - because those are
 * three different questions and a flat list answers none of them. And every
 * card wears its kind, its source and its verdict as marks rather than words,
 * so the page scans as a row of icons at arm's length.
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

/** What a job IS, as a glyph: a playlist, a record, an artist, a song. The
 *  first thing worth knowing about a card, and the cheapest to read. */
function KindIcon({ kind }: { kind: string }) {
  const k = kind.toLowerCase();
  if (k === 'playlist') return <ListMusic size={12} />;
  if (k === 'album') return <Disc3 size={12} />;
  if (k === 'artist') return <User size={12} />;
  return <Music size={12} />;
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
  // A fifty-song playlist used to dump fifty rows onto the page whether or
  // not anyone was reading them. The list opens on ask and on ask only -
  // including while the job runs, since a queue of several playlists all
  // unrolled is the wall this page exists to avoid. The card's own progress
  // (the bar, the percentage, the song coming down now) says enough without
  // it, and the count on the toggle makes opening an informed choice.
  const [open, setOpen] = useState(false);
  const pct = total > 0 ? Math.round((job.completed / total) * 100) : null;
  // The card draws its cover at thumb size, so ask for the 160 variant; the
  // skeleton shimmer holds the square while it downloads alongside the songs.
  const artSrc = artSized(job.artworkUrl, 160) ?? placeholderArt;
  const art = useArtLoad(artSrc, 'dlCard__art');
  return (
    <li className="dlCard" data-state={job.state}>
      <span className="dlCard__artWrap">
        <img {...art} src={artSrc} alt="" loading="lazy" />
        <StateBadge job={job} />
      </span>
      <div className="dlCard__body">
        <span className="dlCard__title">{job.title}</span>
        <span className="dlCard__meta">
          <span className="dlChip dlChip--kind" title={job.kind}>
            <KindIcon kind={job.kind} />
            {job.kind}
          </span>
          {job.service && (
            <span className={`dlChip dlChip--src dlChip--${job.service.toLowerCase()}`} title={job.service}>
              {job.service}
            </span>
          )}
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
        {job.subtitle && <span className="dlCard__sub">{job.subtitle}</span>}
        {active && (
          <span className="dlCard__progress">
            <ProgressBar
              className="dlCard__bar"
              value={job.completed}
              max={total || 1}
              indeterminate={total === 0}
              tone="accent"
              size="sm"
              aria-label="Download progress"
            />
            {pct !== null && <span className="dlCard__pct">{pct}%</span>}
          </span>
        )}
        {job.state === 'downloading' && job.currentTrack && (
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
            coming down right now, what still waits - behind a disclosure so a
            long list is an offer rather than an imposition. */}
        {job.tracks.length > 0 && (
          <>
            <button
              type="button"
              className="dlCard__toggle"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronDown size={13} className="dlCard__chev" data-open={open || undefined} />
              {open ? 'Hide songs' : `${job.tracks.length} songs`}
            </button>
            {open && (
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
          </>
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

/** One number in the status strip, worn as a tile: the glyph is the label. */
function Stat({
  icon,
  count,
  label,
  tone,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
  tone: 'active' | 'queued' | 'done' | 'error';
}) {
  return (
    <span className="dlStat" data-tone={tone} title={`${count} ${label}`}>
      <span className="dlStat__icon" aria-hidden>
        {icon}
      </span>
      <span className="dlStat__num">{count}</span>
      <span className="dlStat__label">{label}</span>
    </span>
  );
}

/** A run of cards under a heading that says what they have in common. */
function Section({
  icon,
  title,
  jobs,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  jobs: MusicImportJob[];
  children: (job: MusicImportJob) => React.ReactNode;
}) {
  if (jobs.length === 0) return null;
  return (
    <section className="dlSection">
      <h2 className="dlSection__title">
        <span className="dlSection__icon" aria-hidden>
          {icon}
        </span>
        {title}
        <span className="dlSection__count">{jobs.length}</span>
      </h2>
      <ul className="dlList downloadsList">{jobs.map((job) => children(job))}</ul>
    </section>
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
  const running = jobs.filter((j) => j.state === 'downloading');
  const queued = jobs.filter((j) => j.state === 'queued');
  const done = jobs.filter((j) => j.state === 'done');
  const failed = jobs.filter((j) => j.state === 'error');
  const finished = jobs.filter((j) => j.state === 'done' || j.state === 'error');
  // Songs, not jobs: what the queue is actually carrying end to end.
  const songsLeft = [...running, ...queued].reduce(
    (n, j) => n + Math.max(0, (j.total ?? 0) - j.completed),
    0,
  );

  const card = (job: MusicImportJob) => (
    <JobCard
      key={job.id}
      job={job}
      onRemove={() => remove(job.id)}
      onRetry={() => retry(job.id)}
      onCancel={() => cancel(job.id)}
    />
  );

  return (
    <div className="homePage downloadsPage">
      {/* What is happening, before a single card is read: the counts as
          tiles, the one line of prose the queue is worth, and its controls. */}
      <header className="dlHead">
        <div className="dlStats">
          <Stat icon={<Download size={15} />} count={running.length} label="downloading" tone="active" />
          <Stat icon={<Clock size={15} />} count={queued.length} label="waiting" tone="queued" />
          <Stat icon={<Check size={15} />} count={done.length} label="done" tone="done" />
          {failed.length > 0 && (
            <Stat icon={<TriangleAlert size={15} />} count={failed.length} label="failed" tone="error" />
          )}
        </div>
        <div className="dlHead__actions">
          {songsLeft > 0 && (
            <span className="dlHead__note">
              {songsLeft} {songsLeft === 1 ? 'song' : 'songs'} to go
            </span>
          )}
          <Button variant={paused ? 'solid' : 'soft'} size="sm" onClick={() => setPaused(!paused)}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
            <span>{paused ? 'Resume' : 'Pause'}</span>
          </Button>
          {finished.length > 0 && (
            <Button variant="ghost" size="sm" onClick={clearFinished} title="Clear finished">
              <ListX size={15} />
              <span>Clear</span>
            </Button>
          )}
        </div>
      </header>

      {paused && (
        <p className="dlPaused" role="status">
          <Pause size={13} /> The queue is paused — downloads already in flight will finish.
        </p>
      )}

      {jobs.length === 0 ? (
        <div className="emptyState emptyState--tall">
          <EmptyArt name="downloads" />
          <p className="downloadsEmpty">
            Nothing in the queue. Add songs from <strong>Discover</strong>, or paste a music link
            into search.
          </p>
        </div>
      ) : (
        <>
          <Section icon={<Download size={15} />} title="Downloading" jobs={running}>
            {card}
          </Section>
          <Section icon={<Clock size={15} />} title="Up next" jobs={queued}>
            {card}
          </Section>
          <Section icon={<Check size={15} />} title="Finished" jobs={finished}>
            {card}
          </Section>
        </>
      )}
    </div>
  );
}
