import { Button, Label, Text } from '@glacier/react';
import { useState } from 'react';
import { useImportServer, importServerHost } from './importServer.ts';
import { retryPeerSync, usePeerSyncStatus } from './peerSyncStatus.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';

/**
 * The other half of "download on the peer": what the peer still owes the hub.
 *
 * A peer that fetches your imports copies each finished song across afterwards
 * so both boxes hold it and playback can keep taking whichever is nearer. That
 * copy is a background queue on the peer, and a failed push has no other
 * symptom - the song plays perfectly from the peer, and the hub simply never
 * gets it. This is where that queue is visible, and the one place the failed
 * ones can be pushed again.
 *
 * Written in the `prefsSection` dialect rather than the settings kit to match
 * the two blocks it sits between; one kit card wedged between two legacy
 * sections reads as a rendering bug, not as a newer style.
 */
export function SyncToHubSection() {
  const t = useT();
  const target = useImportServer();
  const status = usePeerSyncStatus(target);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A hub has no outbox. Saying "0 waiting to copy" on the box everything is
  // already on would be pure noise, so the section is simply not there.
  if (!target) return null;

  /*
   * NOT configured is the one state worth showing.
   *
   * This returned null for it, which meant the download server having no way
   * to reach your library rendered as an empty space - the same empty space as
   * everything being fine. It is also the state that silently breaks the
   * curator handing downloads over: a box that cannot copy back never asks for
   * work in the first place, so the hub offers into nothing and no screen
   * anywhere says why.
   */
  if (!status?.configured) {
    return (
      <div className="prefsSection">
        <Label>{t('servers.syncTitleGeneric')}</Label>
        <Text tone="danger" size="sm">{t('servers.syncNotConfigured', { host: importServerHost(target.url) })}</Text>
        {/* The two names inside that sentence are environment variables, so
            they survive translation as they are written here. */}
        <Text tone="muted" size="xs">{t('servers.syncConfigureHint')}</Text>
      </div>
    );
  }

  const { counts, stall, recent, hub, claiming } = status;
  const waiting = counts.pending + counts.uploading;
  const failed = recent.filter((r) => r.state === 'failed');
  /*
   * Files that are failing but have not FAILED.
   *
   * A transient error defers rather than gives up - the ladder tops out at
   * six-hourly and retries forever, which is right for a hub that was off all
   * weekend and wrong for the person reading this. Without this, a song that
   * has bounced nine times reads as "1 waiting to copy" indefinitely, which is
   * the silent failure this whole section exists to prevent: the song plays
   * perfectly from the peer and the hub simply never gets it. Past a few
   * attempts it has stopped being waiting and started being stuck.
   */
  const stuck = recent.filter((r) => r.state === 'pending' && r.attempts > 4);
  const where = hub || t('servers.yourLibrary');

  /*
   * The tally, as whole counted phrases joined by a middot.
   *
   * Each piece counts something, so each is its own plural key rather than a
   * number glued to a noun: English changes one word between "1 waiting" and
   * "2 waiting", Arabic changes the form five times over. The middot between
   * them is punctuation and stays.
   */
  const tally = [
    waiting > 0 ? t('servers.syncWaiting', { count: waiting, n: formatNumber(waiting) }) : null,
    t('servers.syncCopied', { count: counts.done, n: formatNumber(counts.done) }),
    counts.skipped > 0 ? t('servers.syncAlreadyThere', { count: counts.skipped, n: formatNumber(counts.skipped) }) : null,
    stuck.length > 0 ? t('servers.syncStruggling', { count: stuck.length, n: formatNumber(stuck.length) }) : null,
    counts.failed > 0 ? t('servers.syncFailedCount', { count: counts.failed, n: formatNumber(counts.failed) }) : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="prefsSection">
      <Label>{t('servers.syncTitle', { where })}</Label>

      <Text tone="muted" size="sm">
        {t('servers.syncExplain', { host: importServerHost(target.url), where })}
      </Text>

      {/* Why it is not taking work for the curator, when it is not. The
          downloading happens here, so this is the only place that knows. */}
      {claiming?.why ? (
        <Text tone="warning" size="sm">{t('servers.syncNotClaiming', { why: claiming.why })}</Text>
      ) : null}

      {stall ? (
        <Text tone="danger" size="sm">{t('servers.syncStopped', { reason: stall.reason })}</Text>
      ) : (
        <Text tone="muted" size="xs">{tally}</Text>
      )}

      {/* The paths themselves, because "1 failed" is not something anyone can
          act on and the file name is usually the whole diagnosis. */}
      {failed.length > 0 && (
        <div className="prefsSection">
          {failed.map((item) => (
            <Text key={item.path} tone="muted" size="xs">
              {/* Path and reason are two expressions with an em dash between
                  them, which is a sentence a translator cannot re-punctuate or
                  reorder - some locales want the reason first. One key. */}
              {t('servers.syncFailedItem', {
                path: item.path,
                reason: item.error || t('servers.syncNoReason'),
              })}
            </Text>
          ))}
        </div>
      )}

      {stuck.length > 0 && (
        <div className="prefsSection">
          {stuck.map((item) => (
            <Text key={item.path} tone="muted" size="xs">
              {/* Counted on the attempts, and the reason - when there is one -
                  sits INSIDE the sentence rather than being glued on after a
                  colon: appended, it is a fragment with nowhere to go in a
                  language that leads with the cause. */}
              {item.error
                ? t('servers.syncStillTryingReason', {
                    path: item.path,
                    count: item.attempts,
                    reason: item.error,
                  })
                : t('servers.syncStillTrying', { path: item.path, count: item.attempts })}
            </Text>
          ))}
        </div>
      )}

      {counts.failed > 0 && target.isAdmin && (
        <div className="prefsActions">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setNote(null);
              void retryPeerSync(target)
                .then((n) =>
                  setNote(
                    n > 0
                      ? t('servers.syncQueuedAgain', { count: n, n: formatNumber(n) })
                      : t('servers.syncNothingToRetry'),
                  ),
                )
                .catch((e: unknown) =>
                  setNote(e instanceof Error ? e.message : t('servers.syncRetryFailed')),
                )
                .finally(() => setBusy(false));
            }}
          >
            {t('common.tryAgain')}
          </Button>
        </div>
      )}

      {/* Retrying re-queues work on somebody else's machine, which is why the
          server gates the route on admin; without this line a non-owner would
          just see a button that always fails. */}
      {counts.failed > 0 && !target.isAdmin && (
        <Text tone="muted" size="xs">{t('servers.syncOwnerOnly', { host: importServerHost(target.url) })}</Text>
      )}

      {note && (
        <Text tone="muted" size="sm">
          {note}
        </Text>
      )}
    </div>
  );
}
