import { useEffect, useState } from 'react';
import { Label, ProgressBar, Spinner, Switch, Text } from '@glacier/react';
import { request } from '../api/http.ts';
import { useServerSession } from './serverSession.tsx';

/**
 * What the server does when nobody is asking it for anything.
 *
 * Admin only, because these spend the operator's hardware rather than each
 * listener's: GPU time, disk, and hours of it. They were environment variables,
 * which means in practice they were nothing - nobody edits a systemd unit to
 * decide whether their music box should be busy tonight.
 */

interface Running {
  trackId: number;
  title: string;
  artist: string;
  /** 0..1 through the separation itself. */
  fraction: number;
  /** `separating` while the model runs, `packing` while the parts are written. */
  phase: string;
}

interface Prefetch {
  enabled: boolean;
  /** False when the server has no demucs at all - a different thing from off. */
  available: boolean;
  wanted: number;
  done: number;
  failed: number;
  bytes: number;
  /**
   * The honest pair: how many liked-or-playlisted songs are apart, out of how
   * many there are. The queue's own counts cannot answer this - it is filled a
   * batch at a time, so `wanted` is a few dozen however many thousand remain.
   */
  /* Optional, because a server that has not been rebuilt yet does not send
     them - and the OTA reaches phones hours before somebody pulls on the hub.
     The readout falls back to the counts rather than emptying itself out. */
  separated?: number;
  total?: number;
  /** What the machine is doing right now, or null when it is idle. */
  running?: Running | null;
}

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function BackgroundWork() {
  const { session } = useServerSession();
  const [state, setState] = useState<Prefetch | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * Polled while the pane is open, but only while there is something to watch.
   *
   * This deliberately read ONCE, on the reasoning that a number ticking while
   * you decide whether to switch something off is a distraction. That was right
   * about the counts and wrong about the work: separating a song takes about a
   * minute, so a figure that only moves when a whole one finishes looks stuck,
   * and "is this actually doing anything" is the question people open this row
   * to answer.
   *
   * So it ticks while the server is separating and stops when it is not - the
   * idle case is a settled number that needs no clock, which is what the
   * original reasoning was actually about.
   */
  useEffect(() => {
    if (!session) return;
    let live = true;
    let timer: number | undefined;
    const read = async () => {
      try {
        const next = await request<Prefetch>(session.url, '/api/stems/prefetch', {
          token: session.token,
        });
        if (!live) return;
        setState(next);
        timer = window.setTimeout(read, next.running ? 2_000 : 20_000);
      } catch {
        if (!live) return;
        setState(null);
        // A server that stopped answering is not a reason to hammer it.
        timer = window.setTimeout(read, 20_000);
      }
    };
    void read();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [session]);

  if (!session || !state) return null;

  const flip = async (on: boolean) => {
    setBusy(true);
    setState({ ...state, enabled: on });
    try {
      await request(session.url, '/api/stems/prefetch', {
        method: 'POST',
        token: session.token,
        body: JSON.stringify({ enabled: on }),
      });
    } catch {
      // Put it back: a switch that stays where you left it while the server
      // disagrees is worse than one that springs back.
      setState({ ...state, enabled: !on });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prefsSection" data-setting="stem-prefetch">
      <Label>Background work</Label>
      <Switch
        label="Separate songs before you ask"
        checked={state.enabled && state.available}
        disabled={busy || !state.available}
        onCheckedChange={(on: boolean) => void flip(on)}
      />
      <Text tone="muted" size="sm">
        {!state.available
          ? 'This server does not have the separation tools installed, so there is nothing to turn on.'
          : 'Pulls your liked and playlisted songs apart in the background, so the Pads and the Stems tab open instantly instead of after minutes. Costs GPU time per song and up to 60 GB of the server’s disk. It always yields to a song you ask for.'}
      </Text>
      {state.available && typeof state.total === 'number' && state.total > 0 && (
        <div className="prefetchProgress">
          {/* The whole job, as one bar. Counted against liked-and-playlisted
              songs rather than against stems on disk, so it cannot read 90%
              because somebody separated a lot of things by hand. */}
          <ProgressBar
            value={state.separated ?? 0}
            max={state.total}
            tone="accent"
            size="sm"
            aria-label="Songs separated"
          />
          <Text tone="muted" size="xs">
            {(state.separated ?? 0).toLocaleString()} of {state.total.toLocaleString()} songs apart
            {state.wanted > 0 ? ` · ${state.wanted.toLocaleString()} queued` : ''} · {gb(state.bytes)} used
            {state.failed > 0 ? ` · ${state.failed} could not be separated` : ''}
          </Text>
          {/* Naming the song is what turns a stalled-looking number into
              visible work: this moves every couple of seconds even when the
              count above will not change for another minute. */}
          {state.running && (
            <Text tone="muted" size="xs" className="prefetchProgress__now">
              <Spinner size="sm" aria-hidden />
              {state.running.phase === 'packing' ? 'Filing' : 'Taking apart'}{' '}
              {state.running.title ? `“${state.running.title}”` : 'a song'}
              {state.running.artist ? ` — ${state.running.artist}` : ''}
              {state.running.phase === 'separating' && state.running.fraction > 0
                ? ` · ${Math.round(state.running.fraction * 100)}%`
                : ''}
            </Text>
          )}
          {!state.running && state.enabled && (state.separated ?? 0) >= state.total && (
            <Text tone="muted" size="xs">
              Everything liked or in a playlist is already apart.
            </Text>
          )}
        </div>
      )}
      {/* An older server sends counts but no total. Rather than show nothing
          until somebody rebuilds the hub, say what it does know. */}
      {state.available && typeof state.total !== 'number' && (state.done > 0 || state.wanted > 0) && (
        <Text tone="muted" size="xs">
          {state.done.toLocaleString()} ready · {state.wanted.toLocaleString()} waiting ·{' '}
          {gb(state.bytes)} used
          {state.failed > 0 ? ` · ${state.failed} could not be separated` : ''}
        </Text>
      )}
    </div>
  );
}
