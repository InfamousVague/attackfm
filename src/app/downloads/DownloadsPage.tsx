import { useMemo, useState } from 'react';
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
import { useDownloadsOptional, type MusicImportJob } from '../../plugins/importsBridge.ts';
import {
  PluginHookScope,
  usePluginDownloadSources,
  type ResolvedDownloadSource,
} from '../../plugins/runtime.tsx';
import type { DownloadItem } from '../../plugins/types.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import { useOwnedTrack, usePlayNowOptional } from '../player/playNow.tsx';
import { artSized } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import placeholderArt from '../../assets/attack-wave.png';

/**
 * The Downloads page: every queue in the app, as a destination.
 *
 * A queue is something you WATCH - fifty songs arriving over ten minutes - and
 * a panel that closes when you look away is the wrong container for it.
 *
 * It is also PLURAL. Songs come down through the importer, and whatever a
 * future plugin pulls will come down its own way - but "what is downloading
 * right now" is one question, so it gets one answer in one place. Each source
 * hands over a queue (see PluginDownloadSource in plugins/types.ts) and the
 * page renders them all as the same card, rather than a plugin keeping a
 * private list inside its own page.
 *
 * Three things carry the design. A status strip answers "what is happening"
 * in one glance, before any card is read. The queue is then SPLIT by state -
 * what is coming down now, what waits, what is finished - because those are
 * three different questions and a flat list answers none of them. And every
 * card wears its kind, its source and its verdict as marks rather than words,
 * so the page scans as a row of icons at arm's length.
 */

/** An item with the source it came from riding along, which is what the page
 *  actually sorts, counts and renders. */
interface Row {
  /** `${source.key}:${item.id}` - unique once two sources both call a job '1'. */
  key: string;
  item: DownloadItem;
  source: ResolvedDownloadSource;
}

/** One part's place in its job, derived the same way the importer popover
 *  derives it - the two surfaces must never disagree. */
type PartState = 'done' | 'downloading' | 'error' | 'queued';

function partState(item: DownloadItem, index: number): PartState {
  if (item.state === 'done') return 'done';
  if (index < (item.completed ?? 0)) return 'done';
  if (item.currentIndex === index) return item.state === 'error' ? 'error' : 'downloading';
  return 'queued';
}

function PartIcon({ state }: { state: PartState }) {
  if (state === 'done') return <Check size={13} />;
  if (state === 'downloading') return <Spinner size="sm" aria-label="" />;
  if (state === 'error') return <X size={13} />;
  return <span className="dlTrack__dot" />;
}

/** What a job IS, as a glyph: a playlist, a record, an artist, a book, a song.
 *  The first thing worth knowing about a card, and the cheapest to read. */
function KindIcon({ kind }: { kind: string }) {
  const k = kind.toLowerCase();
  if (k === 'playlist') return <ListMusic size={12} />;
  if (k === 'album') return <Disc3 size={12} />;
  if (k === 'artist') return <User size={12} />;
  return <Music size={12} />;
}

/** The job's state as a badge on its artwork corner - spinner, check or
 *  cross where every other card in the app wears its verdict, no words. */
function StateBadge({ item }: { item: DownloadItem }) {
  if (item.state === 'done')
    return (
      <span className="dlCard__badge" data-state="done" title="Done">
        <Check size={11} />
      </span>
    );
  if (item.state === 'error')
    return (
      <span className="dlCard__badge" data-state="error" title="Failed">
        <X size={11} />
      </span>
    );
  if (item.state === 'downloading')
    return (
      <span className="dlCard__badge" data-state="downloading" title={item.stage ?? 'Downloading'}>
        <Spinner size="sm" aria-label={item.stage ?? 'Downloading'} />
      </span>
    );
  return (
    <span className="dlCard__badge" data-state="queued" title="Queued">
      <Clock size={11} />
    </span>
  );
}

function JobCard({ row, showSource }: { row: Row; showSource: boolean }) {
  const { item, source } = row;
  const active = item.state === 'queued' || item.state === 'downloading';
  const total = item.total ?? 0;
  const parts = item.parts ?? [];
  // A fifty-song playlist used to dump fifty rows onto the page whether or
  // not anyone was reading them. The list opens on ask and on ask only -
  // including while the job runs, since a queue of several playlists all
  // unrolled is the wall this page exists to avoid. The card's own progress
  // (the bar, the percentage, the part coming down now) says enough without
  // it, and the count on the toggle makes opening an informed choice.
  const [open, setOpen] = useState(false);
  /*
   * A download row is about a song, and if that song is already ours the row
   * should be able to start it - including on a row that FAILED. "Earrings"
   * reporting an error while sitting in the library is exactly the confusion
   * this page kept creating: the job is the news, the song is the thing you
   * wanted. So the verb is offered whenever the title resolves to something
   * downloaded, not only when this particular job succeeded.
   *
   * It resolves by name because a job only ever knew a name - see
   * useOwnedTrack. No match, no button: the page never offers a play it
   * cannot perform.
   */
  const playNow = usePlayNowOptional();
  const ownedTrack = useOwnedTrack();
  const owned = ownedTrack(item.title, item.subtitle ?? undefined);
  const pct = total > 0 ? Math.round(((item.completed ?? 0) / total) * 100) : null;
  // The card draws its cover at thumb size, so ask for the 160 variant; the
  // skeleton shimmer holds the square while it downloads alongside the songs.
  const artSrc = artSized(item.artworkUrl ?? null, 160) ?? placeholderArt;
  const art = useArtLoad(artSrc, 'dlCard__art');
  return (
    <li className="dlCard" data-state={item.state}>
      <span className="dlCard__artWrap">
        <img {...art} src={artSrc} alt="" loading="lazy" />
        <StateBadge item={item} />
      </span>
      <div className="dlCard__body">
        <span className="dlCard__title">{item.title}</span>
        <span className="dlCard__meta">
          {/* Who is pulling this, shown only once there is more than one
              answer - with a single source on the page the chip would say the
              same word on every card and mean nothing. */}
          {showSource && (
            <span className="dlChip dlChip--source" title={`${source.label} download`}>
              {source.icon}
              {source.label}
            </span>
          )}
          {item.kind && (
            <span className="dlChip dlChip--kind" title={item.kind}>
              <KindIcon kind={item.kind} />
              {item.kind}
            </span>
          )}
          {total > 0 && (
            <span className="dlChip" title={`${item.completed ?? 0} of ${total}`}>
              <Music size={11} />
              {item.completed ?? 0}/{total}
            </span>
          )}
          {item.state === 'done' && item.note && (
            <span className="dlChip" title={item.note}>
              <CheckCheck size={11} />
              {item.note}
            </span>
          )}
        </span>
        {item.subtitle && <span className="dlCard__sub">{item.subtitle}</span>}
        {active && (
          <span className="dlCard__progress">
            <ProgressBar
              className="dlCard__bar"
              value={item.completed ?? 0}
              max={total || 1}
              indeterminate={total === 0}
              tone="accent"
              size="sm"
              aria-label="Download progress"
            />
            {pct !== null && <span className="dlCard__pct">{pct}%</span>}
          </span>
        )}
        {/* What it is doing right now: the part in flight, or - when a source
            works on one file and has stages instead of parts - the stage, so a
            long decrypt never reads as a stalled bar. */}
        {item.state === 'downloading' && (item.current || item.stage) && (
          <span className="dlCard__track">
            <Spinner size="sm" aria-label="" /> {item.current ?? item.stage}
          </span>
        )}
        {item.state === 'error' && item.error && (
          <span className="dlCard__error">
            <TriangleAlert size={11} /> {item.error}
          </span>
        )}
        {/* The whole album/playlist/book, part by part - what has landed, what
            is coming down right now, what still waits - behind a disclosure so
            a long list is an offer rather than an imposition. */}
        {parts.length > 0 && (
          <>
            <button
              type="button"
              className="dlCard__toggle"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
            >
              <ChevronDown size={13} className="dlCard__chev" data-open={open || undefined} />
              {open ? 'Hide list' : `${parts.length} ${parts.length === 1 ? 'part' : 'parts'}`}
            </button>
            {open && (
              <ol className="dlTracks">
                {parts.map((title, i) => {
                  const st = partState(item, i);
                  return (
                    <li key={i} className={`dlTrack dlTrack--${st}`}>
                      <span className="dlTrack__icon">
                        <PartIcon state={st} />
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
      {/* Verbs a source did not hand over simply do not render: a book queue
          that cannot cancel shows no cancel, rather than a button that lies. */}
      <div className="dlCard__actions">
        {owned && playNow && (
          <button
            type="button"
            className="dlCard__act"
            aria-label={`Play ${item.title}`}
            title="Play"
            onClick={() => playNow(owned)}
          >
            <Play size={16} />
          </button>
        )}
        {item.state === 'error' && item.retry && (
          <button type="button" className="dlCard__act" aria-label="Retry" title="Retry" onClick={item.retry}>
            <RotateCcw size={16} />
          </button>
        )}
        {active
          ? item.cancel && (
              <button type="button" className="dlCard__act" aria-label="Cancel" title="Cancel" onClick={item.cancel}>
                <X size={16} />
              </button>
            )
          : item.remove && (
              <button type="button" className="dlCard__act" aria-label="Remove" title="Remove" onClick={item.remove}>
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
  rows,
  showSource,
}: {
  icon: React.ReactNode;
  title: string;
  rows: Row[];
  showSource: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="dlSection">
      <h2 className="dlSection__title">
        <span className="dlSection__icon" aria-hidden>
          {icon}
        </span>
        {title}
        <span className="dlSection__count">{rows.length}</span>
      </h2>
      <ul className="dlList downloadsList">
        {rows.map((row) => (
          <JobCard key={row.key} row={row} showSource={showSource} />
        ))}
      </ul>
    </section>
  );
}

/**
 * The music importer as a source like any other.
 *
 * It reaches the page through the downloads bridge rather than the plugin
 * contribution, because the bridge predates it and half the app enqueues
 * through it - but the page must not know that, so the difference is flattened
 * here and nowhere else.
 */
function useMusicSource(): ResolvedDownloadSource | null {
  const downloads = useDownloadsOptional();
  return useMemo(() => {
    if (!downloads) return null;
    const { jobs, paused, setPaused, clearFinished, remove, retry, cancel } = downloads;
    return {
      key: 'core:music',
      pluginId: 'spotify-import',
      label: 'Music',
      icon: <Music size={11} />,
      items: jobs.map(
        (job: MusicImportJob): DownloadItem => ({
          id: job.id,
          title: job.title,
          subtitle: job.subtitle,
          kind: job.kind,
          artworkUrl: job.artworkUrl,
          state: job.state,
          error: job.error,
          note: job.skipped ? `${job.skipped} already yours` : null,
          completed: job.completed,
          total: job.total,
          current: job.currentTrack,
          parts: job.tracks,
          currentIndex: job.currentIndex,
          createdAt: job.createdAt,
          retry: () => retry(job.id),
          cancel: () => cancel(job.id),
          remove: () => remove(job.id),
        }),
      ),
      paused,
      setPaused,
      clearFinished,
    };
  }, [downloads]);
}

function DownloadsBoard() {
  const music = useMusicSource();
  const pluginSources = usePluginDownloadSources();
  const sources = useMemo(
    () => (music ? [music, ...pluginSources] : pluginSources),
    [music, pluginSources],
  );

  // Newest first across every queue, so two sources working at once interleave
  // by when their work started rather than by which plugin loaded first. A
  // source that does not date its items keeps its own order at the back.
  const rows: Row[] = useMemo(
    () =>
      sources
        .flatMap((source) =>
          source.items.map((item) => ({ key: `${source.key}:${item.id}`, item, source })),
        )
        .sort((a, b) => (b.item.createdAt ?? 0) - (a.item.createdAt ?? 0)),
    [sources],
  );

  if (sources.length === 0) {
    return (
      <div className="homePage downloadsPage">
        <div className="emptyState emptyState--tall">
          <EmptyArt name="downloads" />
          <p className="downloadsEmpty">
            Nothing here downloads anything yet. Turn on <strong>Music import</strong> in
            Settings → Plugins, and its queue shows up here — along with any other plugin that
            brings one.
          </p>
        </div>
      </div>
    );
  }

  const showSource = sources.length > 1;
  const running = rows.filter((r) => r.item.state === 'downloading');
  const queued = rows.filter((r) => r.item.state === 'queued');
  const done = rows.filter((r) => r.item.state === 'done');
  const failed = rows.filter((r) => r.item.state === 'error');
  const finished = rows.filter((r) => r.item.state === 'done' || r.item.state === 'error');
  // Parts, not jobs: what the queues are actually carrying end to end. Sources
  // that cannot count their parts contribute nothing here rather than a guess.
  const partsLeft = [...running, ...queued].reduce(
    (n, r) => n + Math.max(0, (r.item.total ?? 0) - (r.item.completed ?? 0)),
    0,
  );

  // The header's controls act on every source that offered them: one Pause for
  // the page, not one per plugin, and Clear sweeps all the finished cards.
  const pausable = sources.filter((s) => s.setPaused);
  const paused = pausable.some((s) => s.paused);
  const clearable = sources.filter((s) => s.clearFinished);

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
          {partsLeft > 0 && (
            <span className="dlHead__note">
              {partsLeft} {partsLeft === 1 ? 'file' : 'files'} to go
            </span>
          )}
          {pausable.length > 0 && (
            <Button
              variant={paused ? 'solid' : 'soft'}
              size="sm"
              onClick={() => pausable.forEach((s) => s.setPaused?.(!paused))}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
              <span>{paused ? 'Resume' : 'Pause'}</span>
            </Button>
          )}
          {finished.length > 0 && clearable.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => clearable.forEach((s) => s.clearFinished?.())}
              title="Clear finished"
            >
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

      {rows.length === 0 ? (
        <div className="emptyState emptyState--tall">
          <EmptyArt name="downloads" />
          <p className="downloadsEmpty">
            Nothing in the queue. Add songs from <strong>Discover</strong>, or paste a music link
            into search.
          </p>
        </div>
      ) : (
        <>
          <Section icon={<Download size={15} />} title="Downloading" rows={running} showSource={showSource} />
          <Section icon={<Clock size={15} />} title="Up next" rows={queued} showSource={showSource} />
          <Section icon={<Check size={15} />} title="Finished" rows={finished} showSource={showSource} />
        </>
      )}
    </div>
  );
}

/**
 * The page proper. The scope is here rather than around the whole app because
 * gathering the sources means calling a run of plugin hooks whose LENGTH moves
 * with the enabled set - legal only inside a scope that remounts when that set
 * changes. Keeping it this low costs nothing: the page holds one piece of
 * state (a card's disclosure), and a plugin toggled mid-view is exactly when
 * the queue list should be rebuilt anyway.
 */
export function DownloadsPage() {
  return (
    <PluginHookScope>
      <DownloadsBoard />
    </PluginHookScope>
  );
}
