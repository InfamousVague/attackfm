import { useEffect, useState } from 'react';
import { Label, Switch, Text } from '@glacier/react';
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

interface Prefetch {
  enabled: boolean;
  /** False when the server has no demucs at all - a different thing from off. */
  available: boolean;
  wanted: number;
  done: number;
  failed: number;
  bytes: number;
}

function gb(bytes: number): string {
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function BackgroundWork() {
  const { session } = useServerSession();
  const [state, setState] = useState<Prefetch | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!session) return;
    let live = true;
    // Read once on open, not polled: this is a settings pane, and a number that
    // ticks while you are deciding whether to turn something off is a
    // distraction, not information.
    void request<Prefetch>(session.url, '/api/stems/prefetch', { token: session.token })
      .then((s) => live && setState(s))
      .catch(() => live && setState(null));
    return () => {
      live = false;
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
      {state.available && (state.done > 0 || state.wanted > 0) && (
        <Text tone="muted" size="xs">
          {state.done.toLocaleString()} ready · {state.wanted.toLocaleString()} waiting ·{' '}
          {gb(state.bytes)} used
          {state.failed > 0 ? ` · ${state.failed} could not be separated` : ''}
        </Text>
      )}
    </div>
  );
}
