import { Label, Skeleton, Switch, Text } from '@glacier/react';
import { Check, Disc3, CloudDownload, Hourglass, Music, X } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  fetchCollectorStatus,
  fetchCurator,
  setCollectorSettings,
  type CollectorStatus,
  type CuratorFeed,
} from '../server.ts';
import { formatAgo, formatBytes, formatNumber } from '../ux/format.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import type { Translate } from './settingsShared.ts';

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

/**
 * What each pull is doing, in the reader's terms. Only the states that are
 * genuinely ambiguous get a word - a landed pull is just the song.
 *
 * KEYS, not sentences: this table is built at import, long before a provider
 * exists, so a translated one would freeze the app in whatever language it
 * booted in. The state name is the server's; only the reading is ours.
 */
const WHERE: Partial<Record<string, string>> = {
  offered: 'curator.whereOffered',
  fetching: 'curator.whereFetching',
  queued: 'curator.whereQueued',
  failed: 'curator.whereFailed',
};

/** The two readings of the enrichment line, keyed rather than chosen inline
 *  for the same reason as WHERE above. */
const ENRICHMENT = { ai: 'curator.enrichment', noAi: 'curator.enrichmentNoAi' };

/** How the delegating case reads, which depends entirely on the clock. */
function peerNote(seenAt: number | null, t: Translate): string {
  if (seenAt == null) return t('curator.delegatesNever');
  return t('curator.delegatesLast', { when: formatAgo(seenAt) });
}

export function CuratorSettings() {
  const t = useT();
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
        <Text tone="muted" size="sm">{t('curator.needsServer')}</Text>
      </div>
    );
  }
  if (failed) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">{t('curator.unsupported')}</Text>
      </div>
    );
  }

  const share = status ? Math.min(1, status.ledgerBytes / Math.max(1, status.capBytes)) : 0;
  /** The reading for a pull's state, or '' for the states that speak for
   *  themselves (a landed pull is just the song). */
  const whereFor = (state: string): string => {
    const key = WHERE[state];
    return key ? t(key) : '';
  };

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
          <Label>{t('curator.collector')}</Label>
          <Switch
            label={t('curator.downloadForMe')}
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
              ? t('curator.stateHalted')
              : status.enabled
                ? t('curator.stateHunting')
                : t('curator.stateOff')}
          </Text>

          {/* The ledger: what unadopted music is holding, against the cap. */}
          <div
            className="curatorLedger"
            role="img"
            aria-label={t('curator.ledgerAria', {
              used: formatBytes(status.ledgerBytes),
              cap: formatBytes(status.capBytes),
            })}
          >
            <div className="curatorLedger__rail">
              <div
                className="curatorLedger__fill"
                data-full={status.halted === 'cap' || undefined}
                style={{ inlineSize: `${(share * 100).toFixed(1)}%` }}
              />
            </div>
            <span className="curatorLedger__label">
              {t('curator.ledgerLabel', {
                used: formatBytes(status.ledgerBytes),
                cap: formatBytes(status.capBytes),
              })}
            </span>
          </div>

          <Text tone="muted" size="sm">
            {/* One sentence, one key: the share sits in the middle of it, and
                where a language puts "%" relative to its number is Intl's
                business rather than ours. */}
            {t('curator.reach', {
              share: formatNumber(status.exploration, { style: 'percent', maximumFractionDigits: 0 }),
            })}
          </Text>
          {/*
            * Where the downloading actually happens.
            *
            * The collector can hand its downloads to another box, which meant
            * this pane could show a healthy budget, a full list of picks and
            * no way at all to tell whether a single one of them had been
            * fetched - the work was happening on a machine this page never
            * mentioned. These two sentences are the whole answer: who does the
            * downloading, and whether anything arrived.
            */}
          <Text tone="muted" size="sm">
            {status.delegates
              ? peerNote(status.peerSeenAt, t)
              : status.downloadsHere
                ? t('curator.downloadsHere')
                : t('curator.downloadsNowhere')}
          </Text>
          <Text tone="muted" size="sm">
            {/* Not a plural of the same sentence - nothing arriving is its own
                wording, so the zero case is its own key and the rest counts. */}
            {status.landedToday > 0
              ? t('curator.landedToday', { count: status.landedToday })
              : t('curator.landedNone')}
          </Text>
          {!status.importable && (
            <Text size="sm" className="curatorWarn">
              {t('curator.noLookupTool')}
            </Text>
          )}
        </div>
      )}

      {status && status.recent.length > 0 && (
        <div className="prefsSection">
          <Label>{t('curator.recentPulls')}</Label>
          <ul className="curatorPulls">
            {status.recent.map((r, i) => (
              <li key={`${r.title}:${r.at}:${i}`} className="curatorPull" data-state={r.state}>
                <span className="curatorPull__glyph" aria-hidden>
                  {r.state === 'failed' ? (
                    <X size={14} />
                  ) : r.state === 'promoted' ? (
                    <Check size={14} />
                  ) : r.state === 'offered' ? (
                    <Hourglass size={14} />
                  ) : r.state === 'fetching' ? (
                    <CloudDownload size={14} />
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
                  <span className="curatorPull__reason">
                    {/* The reason is the server's own words and stays as it
                        came; only the state gets a reading. */}
                    {[whereFor(r.state), r.reason].filter(Boolean).join(' · ')}
                  </span>
                </span>
                <span className="curatorPull__when">{formatAgo(r.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {feed && (
        <div className="prefsSection">
          <Label>{t('curator.understanding')}</Label>
          <Text tone="muted" size="sm">
            {/* One sentence rather than five fragments, and it is written out
                twice rather than having the missing-model clause bolted on:
                a translator needs to see where that clause lands, and in some
                languages it does not land at the end. */}
            {t(ENRICHMENT[feed.status.ai ? 'ai' : 'noAi'], {
              checked: formatNumber(feed.progress.checked),
              total: formatNumber(feed.progress.total),
              tempo: formatNumber(feed.progress.withTempo),
              lyrics: formatNumber(feed.progress.withLyrics),
            })}
          </Text>
        </div>
      )}
    </div>
  );
}
