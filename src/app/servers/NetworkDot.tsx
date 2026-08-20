//! Where your music is coming from — read where somebody goes to ask.
//!
//! This used to be a light in the header, on every page. That was the wrong
//! place for it. A status light earns permanent chrome only if it changes often
//! enough to be worth glancing at, and this one does not: a hub on the same
//! network is green from launch to shutdown, so the dot spent its life
//! confirming something nobody was asking about, on every screen, forever.
//!
//! The question it answers — "is my hub reachable, and how far away is it?" —
//! is a question people ask deliberately, when something feels wrong. So it
//! lives in About now, one row under the server it describes, where somebody
//! looking for it will find it and nobody else has to see it.
//!
//! It reads the SAME health the mirror router writes (mirrors.ts probes every
//! server on a heartbeat), so the reading and the routing can never disagree.

import { useEffect, useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import { useConnect } from '../player/playbackSync.tsx';
import { healthOf, mirrorList, mirrorsActive } from './mirrors.ts';
import { LATENCY_CLOSE_MS, latencyBand } from './serverFormat.ts';

export interface NetworkHealth {
  /** True reachable, false unreachable, null not probed yet. */
  ok: boolean | null;
  latencyMs: number | null;
  tone: 'success' | 'warning' | 'neutral';
  /** The latency in the words a person would use. */
  label: string;
  mirrors: number;
  /** Other devices signed into this account and listening. */
  otherDevices: number;
}

/** The latency, in the words a person would use — the Servers page's bands. */
function nearLabel(latencyMs: number | null, ok: boolean | null): string {
  if (ok === null) return 'checking…';
  if (!ok) return 'unreachable — cached songs only';
  if (latencyMs == null) return 'checking…';
  return `${Math.round(latencyMs)}ms · ${latencyBand(latencyMs).label}`;
}

/**
 * The live reading, or null when there is no server to describe.
 *
 * The one-second tick is kept from the old dot: the heartbeat probes on its own
 * clock, and this re-reads its answer often enough that the reading never lags
 * a state change by long. It costs a state update a second only while whatever
 * mounts this is actually on screen — which, now that this is a settings row
 * rather than header chrome, is a few seconds a month rather than always.
 */
export function useNetworkHealth(): NetworkHealth | null {
  const { session } = useServerSession();
  const connect = useConnect();
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), 1_000);
    return () => window.clearInterval(t);
  }, []);

  if (!session) return null;

  const health = healthOf(session.url);
  // Unknown is unknown: before the first probe answers this sits neutral,
  // because defaulting to "healthy" painted a green light over a library that
  // could not load — the one state it exists to catch.
  const ok = health?.ok ?? null;
  const latencyMs = health?.latencyMs ?? null;
  return {
    ok,
    latencyMs,
    tone: !ok ? 'neutral' : latencyMs != null && latencyMs >= LATENCY_CLOSE_MS ? 'warning' : 'success',
    label: nearLabel(latencyMs, ok),
    mirrors: mirrorsActive() ? mirrorList().length : 0,
    otherDevices: connect.connected
      ? connect.devices.filter((d) => d.id !== connect.thisDeviceId).length
      : 0,
  };
}
