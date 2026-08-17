import { Label, Skeleton, Switch, Text } from '@glacier/react';
import { Check, Disc3, Music, X } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  fetchCollectorStatus,
  fetchCurator,
  setCollectorSettings,
  type CollectorStatus,
  type CuratorFeed,
} from '../server.ts';

/**
 * The curator's control room: the one place the machine accounts for itself.
 *
 * Everything else about the curator is ambient - shelves appear, playlists
 * refresh, music arrives. This pane is where you see the ledger (how much of
 * the budget its unadopted downloads are holding), read what it pulled lately
 * and why, watch the enrichment progress that powers the recommendations, and
 * turn the autonomous half off if the house guest overstays.
 *
 * The off switch stops the DOWNLOADING only. The mixes, the suggestions and
 * the enrichment keep running - they spend nothing but electricity.
 */

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
}

function timeAgo(ms: number): string {
  const mins = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function CuratorSettings() {
  const { session } = useServerSession();
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  const [feed, setFeed] = useState<CuratorFeed | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    setFailed(false);
    void Promise.all([
      fetchCollectorStatus(session, ctrl.signal).then(setStatus),
      fetchCurator(session, ctrl.signal).then(setFeed),
    ]).catch(() => {
      if (!ctrl.signal.aborted) setFailed(true);
    });
    return () => ctrl.abort();
  }, [session]);

  if (!session) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          The curator lives on your server — connect to one to see it.
        </Text>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          This server does not have the curator yet — it needs the current home-hub build.
        </Text>
      </div>
    );
  }

  const share = status ? Math.min(1, status.ledgerBytes / Math.max(1, status.capBytes)) : 0;

  return (
    <div className="prefsBody">
      {/* The pane is otherwise blank until the status lands, which on a slow
          hub reads as "there is nothing here" rather than "still asking". */}
      {!status && (
        <div className="prefsSection" aria-busy>
          <Skeleton variant="text" width="9rem" />
          <Skeleton variant="rect" height="0.5rem" radius="var(--glacier-radius-full)" />
          <Skeleton variant="text" width="12rem" />
        </div>
      )}
      {status && (
        <div className="prefsSection">
          <Label>Collector</Label>
          <Switch
            label="Download music for me"
            checked={status.enabled}
            onCheckedChange={(on: boolean) => {
              // Optimistic - the switch answers the press; a refusal puts it back.
              setStatus({ ...status, enabled: on });
              void setCollectorSettings(session, { enabled: on }).catch(() =>
                setStatus((prev) => (prev ? { ...prev, enabled: !on } : prev)),
              );
            }}
          />
          <Text tone="muted" size="sm">
            {status.halted === 'cap'
              ? 'Stopped: the budget below is full of music nobody has adopted yet.'
              : status.enabled
                ? 'Hunting continuously. Everything it fetches auditions on the For-you shelf first.'
                : 'Off. Mixes and suggestions keep running — only the downloading stops.'}
          </Text>

          {/* The ledger: what unadopted music is holding, against the cap. */}
          <div className="curatorLedger" role="img" aria-label={`Budget: ${gb(status.ledgerBytes)} of ${gb(status.capBytes)} holding auditions`}>
            <div className="curatorLedger__rail">
              <div
                className="curatorLedger__fill"
                data-full={status.halted === 'cap' || undefined}
                style={{ inlineSize: `${(share * 100).toFixed(1)}%` }}
              />
            </div>
            <span className="curatorLedger__label">
              {gb(status.ledgerBytes)} of {gb(status.capBytes)} auditioning
            </span>
          </div>

          <Text tone="muted" size="sm">
            Reach: {(status.exploration * 100).toFixed(0)}% adventurous — it tunes itself from what
            you keep and what you skip.
          </Text>
          {!status.importable && (
            <Text size="sm" className="curatorWarn">
              The server has no downloader tool installed, so pulls will fail — check the home-hub
              setup.
            </Text>
          )}
        </div>
      )}

      {status && status.recent.length > 0 && (
        <div className="prefsSection">
          <Label>Recent pulls</Label>
          <ul className="curatorPulls">
            {status.recent.map((r, i) => (
              <li key={`${r.title}:${r.at}:${i}`} className="curatorPull" data-state={r.state}>
                <span className="curatorPull__glyph" aria-hidden>
                  {r.state === 'failed' ? (
                    <X size={14} />
                  ) : r.state === 'promoted' ? (
                    <Check size={14} />
                  ) : r.kind === 'album' ? (
                    <Disc3 size={14} />
                  ) : (
                    <Music size={14} />
                  )}
                </span>
                <span className="curatorPull__text">
                  <span className="curatorPull__title">
                    {r.title} · {r.artist}
                  </span>
                  {r.reason && <span className="curatorPull__reason">{r.reason}</span>}
                </span>
                <span className="curatorPull__when">{timeAgo(r.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {feed && (
        <div className="prefsSection">
          <Label>Understanding your library</Label>
          <Text tone="muted" size="sm">
            {feed.progress.checked.toLocaleString()} of {feed.progress.total.toLocaleString()} songs
            read · {feed.progress.withTempo.toLocaleString()} with a measured tempo ·{' '}
            {feed.progress.withLyrics.toLocaleString()} with their words understood
            {feed.status.ai ? '' : ' · no local model connected, so words are not being read'}
          </Text>
        </div>
      )}
    </div>
  );
}
