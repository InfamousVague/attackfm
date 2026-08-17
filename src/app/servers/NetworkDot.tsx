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
import { LATENCY_CLOSE_MS, latencyBand } from './serverFormat.ts';

function hostOf(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** The latency, in the words a person would use - the Servers page's bands. */
function nearLabel(latencyMs: number | null, ok: boolean): string {
  if (!ok) return 'unreachable — cached songs only';
  if (latencyMs == null) return 'checking…';
  return `${Math.round(latencyMs)}ms · ${latencyBand(latencyMs).label}`;
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
  // Unknown is unknown: before the first probe answers the dot sits
  // neutral, because defaulting to "healthy" painted a green light over a
  // library that could not load - the one state the dot exists to catch.
  const ok = health?.ok ?? null;
  const latency = health?.latencyMs ?? null;
  const tone: 'success' | 'warning' | 'neutral' = !ok
    ? 'neutral'
    : latency != null && latency >= LATENCY_CLOSE_MS
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
        <button type="button" className="netDot" aria-label={`Network: ${nearLabel(latency, ok === true)}`}>
          <StatusDot tone={tone} pulse={ok === true} size="sm" />
        </button>
      }
    >
      <div className="netDot__panel">
        <div className="netDot__row">
          <span className="netDot__host">{hostOf(session.url)}</span>
          <Text tone={ok === false ? 'danger' : 'muted'} size="xs">
            {ok === null ? 'Checking…' : nearLabel(latency, ok)}
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
