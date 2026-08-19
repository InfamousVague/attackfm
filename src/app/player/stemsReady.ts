import { useEffect, useState } from 'react';
import { requestStems, stemStatus, type StemStatus } from '../api/stems.ts';
import { trackIdFromPath } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import type { ServerSession } from '../api/http.ts';

/**
 * Waiting for a song to come apart, once, however many things are watching.
 *
 * The separator is slow by nature - a demucs pass is tens of seconds - so every
 * surface that wants stems has to ask, wait, and describe the wait. Three of
 * them wrote that loop separately and polled the same song independently, each
 * on its own interval, each taking the server's one database lock three times a
 * poll. This is that loop, once, with the listeners fanned out.
 */

export interface StemProgress {
  phase: 'asking' | 'queued' | 'separating' | 'packing';
  /** 0..1, or null on a server that does not report it. */
  fraction: number | null;
  /** Stems written so far. */
  filed: number;
  /** Jobs ahead of this one, when the server says. */
  ahead: number | null;
  /** Seconds since we started waiting - the one number always available, and
   *  the difference between a job that is working and one that looks dead. */
  seconds: number;
}

export type StemsOutcome =
  | { ok: true; stems: string[] }
  | { ok: false; reason: 'no-separator' | 'failed' | 'offline' | 'empty' | 'aborted'; problem: string };

interface Options {
  onProgress?: (p: StemProgress) => void;
  signal?: AbortSignal;
  /** False just looks; true queues the work if it is not there. */
  make?: boolean;
}

const POLL_MS = 1000;

/** One in-flight wait per song, so two surfaces on the same track share it. */
const inFlight = new Map<string, Promise<StemsOutcome>>();

function key(session: ServerSession, trackId: number): string {
  return `${session.url}#${trackId}`;
}

/**
 * Make sure a song is separated, and resolve when it is.
 *
 * The order matters and is the one Pads got right: LOOK FIRST, always, and only
 * ask for work if there is none. `stems::request` answers 503 on a server with
 * no demucs, so an unconditional POST would turn "already separated, on a box
 * that has since lost its tools" into an error about a song that is sitting
 * right there ready to play.
 */
export async function ensureStems(
  session: ServerSession,
  trackId: number,
  opts: Options = {},
): Promise<StemsOutcome> {
  const k = key(session, trackId);
  const running = inFlight.get(k);
  if (running) return running;

  const job = run(session, trackId, opts).finally(() => {
    if (inFlight.get(k) === job) inFlight.delete(k);
  });
  inFlight.set(k, job);
  return job;
}

async function run(
  session: ServerSession,
  trackId: number,
  { onProgress, signal, make = true }: Options,
): Promise<StemsOutcome> {
  const began = Date.now();
  const since = () => Math.round((Date.now() - began) / 1000);
  const tell = (phase: StemProgress['phase'], s: StemStatus | null) =>
    onProgress?.({
      phase,
      fraction: s?.progress ?? null,
      filed: s?.stems.length ?? 0,
      ahead: s?.queuedAhead ?? null,
      seconds: since(),
    });

  const gone = () => signal?.aborted === true;

  let now: StemStatus;
  try {
    tell('asking', null);
    now = await stemStatus(session, trackId, signal);
  } catch (err) {
    if (gone()) return { ok: false, reason: 'aborted', problem: '' };
    return { ok: false, reason: 'offline', problem: message(err) };
  }

  if (now.stems.length > 0) return { ok: true, stems: now.stems.map((s) => s.stem) };
  // The only honest "this server cannot do it at all" - checked before asking,
  // so a box without demucs says so rather than answering 503 to a POST.
  if (!now.available) {
    return { ok: false, reason: 'no-separator', problem: 'This server does not have the separation tools.' };
  }
  if (!make) return { ok: false, reason: 'empty', problem: '' };

  try {
    await requestStems(session, trackId);
  } catch (err) {
    if (gone()) return { ok: false, reason: 'aborted', problem: '' };
    return { ok: false, reason: 'offline', problem: message(err) };
  }

  for (;;) {
    if (gone()) return { ok: false, reason: 'aborted', problem: '' };
    await new Promise((r) => window.setTimeout(r, POLL_MS));
    if (gone()) return { ok: false, reason: 'aborted', problem: '' };

    try {
      now = await stemStatus(session, trackId, signal);
    } catch (err) {
      if (gone()) return { ok: false, reason: 'aborted', problem: '' };
      return { ok: false, reason: 'offline', problem: message(err) };
    }

    // Files on disk is the ONLY readiness test. A job can report done while the
    // packing that writes them is still finishing, and a reader that trusted
    // the word rather than the files would open a song with nothing in it.
    if (now.stems.length > 0 && now.state !== 'running' && now.state !== 'queued') {
      return { ok: true, stems: now.stems.map((s) => s.stem) };
    }
    if (now.state === 'failed') {
      return {
        ok: false,
        reason: 'failed',
        problem: now.error || 'That one could not be separated.',
      };
    }
    tell(
      now.phase === 'packing'
        ? 'packing'
        : now.state === 'running'
          ? 'separating'
          : 'queued',
      now,
    );
  }
}

function message(err: unknown): string {
  return err instanceof Error && err.message ? err.message : 'Your server did not answer.';
}

export interface StemsView {
  state: 'idle' | 'checking' | 'making' | 'ready' | 'problem';
  stems: string[];
  progress: StemProgress | null;
  problem: string;
  /** True only for "this server has no separator", which is worth saying
   *  differently from a song that simply failed. */
  noSeparator: boolean;
  /** Start (or retry) the separation. */
  make: () => void;
}

/**
 * The same wait, as a hook.
 *
 * `make` defaults to false: opening a panel should never be what commits a
 * machine to half a minute of demucs. The surfaces that want it immediate
 * (the board, whose whole purpose is the separated parts) pass true.
 */
export function useStems(path: string | null, opts: { make?: boolean } = {}): StemsView {
  const { session } = useServerSession();
  const id = path ? trackIdFromPath(path) : null;
  const [view, setView] = useState<StemsView>(() => blank());
  const [attempt, setAttempt] = useState(0);
  const wanted = opts.make === true;

  useEffect(() => {
    if (!session || id === null) {
      setView(blank());
      return;
    }
    const control = new AbortController();
    setView({ ...blank(), state: 'checking' });

    void ensureStems(session, id, {
      make: wanted || attempt > 0,
      signal: control.signal,
      onProgress: (p) =>
        setView((v) => ({ ...v, state: p.phase === 'asking' ? 'checking' : 'making', progress: p })),
    }).then((out) => {
      if (control.signal.aborted) return;
      if (out.ok) {
        setView({ ...blank(), state: 'ready', stems: out.stems });
      } else if (out.reason === 'aborted') {
        // The song changed under us; whatever replaced it owns the view now.
      } else if (out.reason === 'empty') {
        setView(blank());
      } else {
        setView({
          ...blank(),
          state: 'problem',
          problem: out.problem,
          noSeparator: out.reason === 'no-separator',
        });
      }
    });

    return () => control.abort();
  }, [session, id, wanted, attempt]);

  return { ...view, make: () => setAttempt((n) => n + 1) };
}

function blank(): StemsView {
  return { state: 'idle', stems: [], progress: null, problem: '', noSeparator: false, make: () => {} };
}
