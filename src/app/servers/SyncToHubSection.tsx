import { Button, Label, Text } from '@glacier/react';
import { useState } from 'react';
import { useImportServer, importServerHost } from './importServer.ts';
import { retryPeerSync, usePeerSyncStatus } from './peerSyncStatus.ts';

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
        <Label>Copying to your library</Label>
        <Text tone="danger" size="sm">
          {importServerHost(target.url)} has not been told where your library is, so nothing it
          downloads can be copied back — and it will not take on new music for you either.
        </Text>
        <Text tone="muted" size="xs">
          Set AFM_PEER_SYNC_URL and AFM_PEER_SYNC_TOKEN on that server and restart it.
        </Text>
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

  return (
    <div className="prefsSection">
      <Label>Copying to {hub || 'your library'}</Label>

      <Text tone="muted" size="sm">
        {importServerHost(target.url)} downloads your imports and then copies each finished song to{' '}
        {hub || 'your library'}, so both servers end up holding it.
      </Text>

      {/* Why it is not taking work for the curator, when it is not. The
          downloading happens here, so this is the only place that knows. */}
      {claiming?.why ? (
        <Text tone="warning" size="sm">
          Not taking new music for you: {claiming.why}
        </Text>
      ) : null}

      {stall ? (
        <Text tone="danger" size="sm">
          Stopped: {stall.reason}
        </Text>
      ) : (
        <Text tone="muted" size="xs">
          {waiting > 0
            ? `${waiting} waiting · ${counts.done.toLocaleString()} copied`
            : `${counts.done.toLocaleString()} copied`}
          {counts.skipped > 0 ? ` · ${counts.skipped.toLocaleString()} already there` : ''}
          {stuck.length > 0 ? ` · ${stuck.length} struggling` : ''}
          {counts.failed > 0 ? ` · ${counts.failed} failed` : ''}
        </Text>
      )}

      {/* The paths themselves, because "1 failed" is not something anyone can
          act on and the file name is usually the whole diagnosis. */}
      {failed.length > 0 && (
        <div className="prefsSection">
          {failed.map((item) => (
            <Text key={item.path} tone="muted" size="xs">
              {item.path} — {item.error || 'no reason given'}
            </Text>
          ))}
        </div>
      )}

      {stuck.length > 0 && (
        <div className="prefsSection">
          {stuck.map((item) => (
            <Text key={item.path} tone="muted" size="xs">
              {item.path} — still trying after {item.attempts} attempts
              {item.error ? `: ${item.error}` : ''}
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
                .then((n) => setNote(n > 0 ? `${n} queued again.` : 'Nothing left to retry.'))
                .catch((e: unknown) =>
                  setNote(e instanceof Error ? e.message : 'Could not queue them again.'),
                )
                .finally(() => setBusy(false));
            }}
          >
            Try again
          </Button>
        </div>
      )}

      {/* Retrying re-queues work on somebody else's machine, which is why the
          server gates the route on admin; without this line a non-owner would
          just see a button that always fails. */}
      {counts.failed > 0 && !target.isAdmin && (
        <Text tone="muted" size="xs">
          Only the owner of {importServerHost(target.url)} can send these again.
        </Text>
      )}

      {note && (
        <Text tone="muted" size="sm">
          {note}
        </Text>
      )}
    </div>
  );
}
