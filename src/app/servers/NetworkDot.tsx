//! Where your music is coming from, as one small light.
//!
//! Server-ness used to be smeared across settings panes; the day-to-day
//! question - "is my hub reachable, and how far away is it?" - deserved a
//! glance, not a pane. The dot sits in the header: green means the server is
//! close and answering, amber means far or laggy (or a mirror doing the
//! serving), grey means unreachable - cached songs only. Tapping it names the
//! host, the latency in human words, who else is listening through this
//! account, and offers the one door into the full network settings.
//!
//! It reads the SAME health the mirror router writes (mirrors.ts probes every
//! server on a heartbeat), so the light and the routing can never disagree.

import { Button, Popover, StatusDot, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import { useConnect } from '../player/playbackSync.tsx';
import { healthOf, mirrorList, mirrorsActive } from './mirrors.ts';

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** The latency, in the words a person would use. */
function nearLabel(latencyMs: number | null, ok: boolean): string {
  if (!ok) return 'unreachable — cached songs only';
  if (latencyMs == null) return 'checking…';
  if (latencyMs < 40) return `${Math.round(latencyMs)}ms · same network`;
  if (latencyMs < 150) return `${Math.round(latencyMs)}ms · close`;
  if (latencyMs < 400) return `${Math.round(latencyMs)}ms · far`;
  return `${Math.round(latencyMs)}ms · very far`;
}

export function NetworkDot({ onManage }: { onManage: () => void }) {
  const { session } = useServerSession();
  const connect = useConnect();
  // The heartbeat probes on its own clock; this just re-reads its answer
  // often enough that the light never lags a state change by long.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 10_000);
    return () => window.clearInterval(t);
  }, []);

  if (!session) return null;

  const health = healthOf(session.url);
  const ok = health?.ok ?? true;
  const latency = health?.latencyMs ?? null;
  const tone: 'success' | 'warning' | 'neutral' = !ok
    ? 'neutral'
    : latency != null && latency >= 150
      ? 'warning'
      : 'success';
  const mirrors = mirrorList();
  const online = connect.devices.filter((d) => d.id !== connect.thisDeviceId).length;

  return (
    <Popover
      placement="bottom"
      aria-label="Network"
      className="netDotPanel"
      trigger={
        <button type="button" className="netDot" aria-label={`Network: ${nearLabel(latency, ok)}`}>
          <StatusDot tone={tone} pulse={ok} size="sm" />
        </button>
      }
    >
      <div className="netDot__panel">
        <div className="netDot__row">
          <span className="netDot__host">{hostOf(session.url)}</span>
          <Text tone={ok ? 'muted' : 'danger'} size="xs">
            {nearLabel(latency, ok)}
          </Text>
        </div>
        {mirrorsActive() && mirrors.length > 0 && (
          <Text tone="muted" size="xs">
            {mirrors.length === 1 ? '1 mirror' : `${mirrors.length} mirrors`} standing by
          </Text>
        )}
        {connect.connected && online > 0 && (
          <Text tone="muted" size="xs">
            {online === 1 ? '1 other device' : `${online} other devices`} on this account
          </Text>
        )}
        <Button variant="outline" size="sm" onClick={onManage}>
          Manage network
        </Button>
      </div>
    </Popover>
  );
}
