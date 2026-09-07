import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Modal, Spinner, Text } from '@glacier/react';
import { AlertTriangle, Check, Pause, Play } from 'lucide-react';
import {
  fetchRefetch,
  keepCandidate,
  refetchAudioUrl,
  scrapRefetch,
  ServerError,
  startRefetch,
  trackIdFromPath,
  type RefetchCandidate,
  type RefetchJob,
} from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { formatClock, formatNumber } from '../ux/format.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * "That's the wrong song."
 *
 * The importer resolves a song by searching providers for its title and
 * artist, and takes the first answer. Usually right; sometimes it is a live
 * cut, a radio edit, a remix, or a cover by somebody else entirely - and the
 * file is TAGGED correctly regardless, because the tags come from the source.
 * Nothing in the library can tell. Only listening can.
 *
 * So this is a listening room. The server fetches several alternates into
 * staging, and they appear here as they land, each playable in place against
 * the one currently in the library. Nothing is committed until a choice is
 * made: the library keeps playing the old file the entire time this is open,
 * and closing without choosing leaves everything exactly as it was.
 *
 * Two things do most of the work before any audio plays. The catalogue's own
 * title is shown, because "(12 Mix)" or "(As Made Famous By…)" is frequently
 * the whole answer. And the LENGTH of what actually downloaded sits next to
 * the length of what is in the library - a live take or an extended mix
 * usually declares itself as a minute of difference.
 */
export function WrongSongModal({
  track,
  open,
  onClose,
  onReplaced,
}: {
  track: Track | null;
  open: boolean;
  onClose: () => void;
  onReplaced?: (newTrackId: number) => void;
}) {
  const { session } = useServerSession();
  const t = useT();
  const [job, setJob] = useState<RefetchJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  /* A server too old for this endpoint is a STATE, not a message. Held apart
     from `error` - which carries whatever the server actually said, in
     whatever language it said it - so our own sentence can be resolved at
     paint and follow a language change, rather than being frozen into state
     by the language the hunt happened to start in. */
  const [unsupported, setUnsupported] = useState(false);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Held in a ref so the cleanup can scrap the job without re-running the
  // effect every time a poll updates it.
  const jobRef = useRef<RefetchJob | null>(null);
  jobRef.current = job;

  // The library's own id, read out of the afm:// path - the client Track
  // carries a path, not the server's row id.
  const trackId = track ? trackIdFromPath(track.path) : null;

  // Start the hunt when the modal opens, and poll until it settles.
  useEffect(() => {
    if (!open || !session || trackId === null) return;
    let alive = true;
    const controller = new AbortController();
    setJob(null);
    setError(null);
    setUnsupported(false);

    void (async () => {
      try {
        const started = await startRefetch(session, trackId);
        if (!alive) return;
        setJob(started);
        // Poll while anything is still moving. Candidates land one at a time
        // and each is playable the moment it does, so there is something to
        // do long before the last one finishes.
        while (alive) {
          await new Promise((r) => setTimeout(r, 1200));
          if (!alive) return;
          const next = await fetchRefetch(session, started.id, controller.signal);
          if (!alive) return;
          setJob(next);
          if (next.state === 'ready' || next.state === 'failed') break;
        }
      } catch (e) {
        if (!alive) return;
        // A 404 on the start call is not a failed hunt - it is a server from
        // before this feature existed. Say that, and say the way out: the
        // whole flow lives on the box that owns the files, so no app update
        // can stand in for the server's.
        if (e instanceof ServerError && e.status === 404) {
          setUnsupported(true);
        } else {
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [open, session, trackId]);

  // Whatever is previewing stops when the modal goes.
  useEffect(() => {
    if (open) return;
    audioRef.current?.pause();
    setPlaying(null);
  }, [open]);

  /**
   * Leaving without choosing. The library is untouched either way; what differs
   * is whether the HUNT survives.
   *
   * It used to be scrapped unconditionally, which meant closing the box killed
   * five provider downloads mid-flight - and since a candidate can take up to
   * the five-minute per-track timeout to arrive, closing it is exactly what
   * anybody does while waiting. Reopening then started the whole thing again
   * from nothing. That is why alternates "never loaded": they were being
   * cancelled and restarted, not failing.
   *
   * So a hunt still working is left to work. The server hands the same job back
   * on the next open (see refetch::start), so walking away and coming back is
   * now the intended way to use this rather than the way to lose everything.
   * A hunt that has SETTLED is scrapped as before - nothing more is coming, and
   * the staged files are only worth their disk while somebody might choose one.
   */
  const close = useCallback(() => {
    audioRef.current?.pause();
    setPlaying(null);
    const live = jobRef.current;
    if (session && live && live.state !== 'hunting') {
      void scrapRefetch(session, live.id).catch(() => {});
    }
    setJob(null);
    onClose();
  }, [session, onClose]);

  const preview = (index: number) => {
    if (!session || !job) return;
    const el = audioRef.current;
    if (!el) return;
    if (playing === index) {
      el.pause();
      setPlaying(null);
      return;
    }
    el.src = refetchAudioUrl(session, job.id, index);
    el.currentTime = 0;
    void el.play().catch(() => setPlaying(null));
    setPlaying(index);
  };

  const choose = async (index: number) => {
    if (!session || !job) return;
    setBusy(true);
    audioRef.current?.pause();
    setPlaying(null);
    try {
      const result = await keepCandidate(session, job.id, index);
      setJob(null);
      onReplaced?.(result.trackId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const hunting = job?.state === 'hunting' || (!job && !error && !unsupported);
  const currentMs = job?.current.durationMs ?? null;

  return (
    <Modal
      open={open}
      onClose={close}
      title={t('library.wrongSong')}
      description={t('library.wrongSongBlurb')}
      size="lg"
      footer={
        <div className="wrongSong__foot">
          <Button variant="ghost" onClick={close} disabled={busy}>
            {t('library.keepWhatIHave')}
          </Button>
        </div>
      }
    >
      {/* A preview player, deliberately separate from the app's own: the
          library track keeps its place in the deck while candidates are
          auditioned, so backing out costs nothing. */}
      <audio ref={audioRef} onEnded={() => setPlaying(null)} preload="none" />

      {track && (
        <div className="wrongSong__current">
          <Text size="xs" tone="muted">
            {t('library.inLibraryNow')}
          </Text>
          <Text weight="medium">{track.title}</Text>
          <Text size="sm" tone="muted">
            {track.artist} · {fmt(currentMs ?? (track.duration ?? 0) * 1000)}
            {job?.current.lossless ? ` · ${t('library.lossless')}` : ''}
          </Text>
        </div>
      )}

      {(error || unsupported) && (
        <div className="wrongSong__error">
          <AlertTriangle size={15} />
          <Text size="sm">{unsupported ? t('library.wrongSongUnsupported') : error}</Text>
        </div>
      )}

      {job?.error && !error && (
        <div className="wrongSong__error">
          <AlertTriangle size={15} />
          <Text size="sm">{job.error}</Text>
        </div>
      )}

      {/* Said while it is still working, because the answer to "this is taking
          a while" is now genuinely "then go and do something else" - and
          nobody will try that unless they are told it is safe. Closing used to
          throw the whole hunt away. */}
      {hunting && (
        <div className="wrongSong__hunting">
          <Spinner size="sm" />
          <Text size="sm" tone="muted">
            {/* Two states, not two number forms: something has landed, or
                nothing has yet. So two keys chosen here rather than a count. */}
            {job?.candidates.length
              ? t('library.wrongSongFetchingRest')
              : t('library.wrongSongLooking')}
          </Text>
        </div>
      )}

      <div className="wrongSong__list">
        {job?.candidates.map((c) => (
          <CandidateRow
            key={c.index}
            candidate={c}
            currentMs={currentMs}
            playing={playing === c.index}
            busy={busy}
            onPreview={() => preview(c.index)}
            onChoose={() => void choose(c.index)}
          />
        ))}
      </div>
    </Modal>
  );
}

function CandidateRow({
  candidate: c,
  currentMs,
  playing,
  busy,
  onPreview,
  onChoose,
}: {
  candidate: RefetchCandidate;
  currentMs: number | null;
  playing: boolean;
  busy: boolean;
  onPreview: () => void;
  onChoose: () => void;
}) {
  const t = useT();
  const ready = c.state === 'ready';
  const drift = ready && currentMs && c.durationMs ? c.durationMs - currentMs : 0;

  return (
    <div className={`wrongSong__row${ready ? '' : ' wrongSong__row--waiting'}`}>
      <button
        className="wrongSong__play"
        onClick={onPreview}
        disabled={!ready}
        aria-label={playing ? t('library.stopTrack', { title: c.title }) : t('library.playTrack', { title: c.title })}
      >
        {c.state === 'downloading' || c.state === 'queued' ? (
          <Spinner size="sm" />
        ) : playing ? (
          <Pause size={16} />
        ) : (
          <Play size={16} />
        )}
      </button>

      <div className="wrongSong__meta">
        <Text size="sm" weight="medium">
          {c.title}
        </Text>
        <Text size="xs" tone="muted">
          {c.artist} · {c.source}
          {ready && c.durationMs ? ` · ${fmt(c.durationMs)}` : ''}
          {ready && c.lossless ? ` · ${t('library.lossless')}` : ''}
        </Text>
        {/* The number that most often settles it without listening. */}
        {ready && Math.abs(drift) >= 3000 && (
          <Text size="xs" tone="muted">
            {/* One sentence per direction rather than "…longer" + " than
                yours" as siblings: the comparison word does not sit in the
                same place in every language, and a fragment cannot move. */}
            {drift > 0
              ? t('library.driftLonger', { length: fmt(drift) })
              : t('library.driftShorter', { length: fmt(-drift) })}
          </Text>
        )}
        {ready && c.sameAs !== null && (
          <Text size="xs" tone="muted">
            {t('library.sameLengthAs', { n: formatNumber((c.sameAs ?? 0) + 1) })}
          </Text>
        )}
        {c.state === 'failed' && (
          <Text size="xs" tone="muted">
            {/* The server's reason, when there is one, is INSIDE the
                sentence rather than appended to it - the clause hangs off the
                other end in a language that puts it there. */}
            {c.error ? t('library.fetchFailedWhy', { reason: c.error }) : t('library.fetchFailed')}
          </Text>
        )}
      </div>

      <Button size="sm" variant="soft" disabled={!ready || busy} onClick={onChoose}>
        <Check size={14} /> {t('library.useThis')}
      </Button>
    </div>
  );
}

/** m:ss from milliseconds - the house clock, with the unit converted here. */
function fmt(ms: number): string {
  return formatClock(ms / 1000);
}
