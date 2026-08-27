import type { ReactNode } from 'react';
import { Button, Select, Text } from '@glacier/react';
import { PaneSection, SettingRow } from '../settings/kit/settingsKit.tsx';
import { healthOf } from './mirrors.ts';
import { latencyBand } from './serverFormat.ts';
import {
  clearImportServerFault,
  importServerFault,
  importServerHost,
  setImportServerUrl,
  useImportServer,
  useImportTargets,
  useOrphanedImportChoice,
} from './importServer.ts';
import { usePeerSyncStatus, type PeerSyncStatus } from './peerSyncStatus.ts';
import { useServerSession } from './serverSession.tsx';
import type { ServerSession } from '../server.ts';
import type { ImportServerFault } from './importServer.ts';

/**
 * "Download on <box>" - the one control that says which server fetches a link.
 *
 * This ships from CORE even though the only thing that renders it is the
 * importer plugin, for two reasons. A plugin bundle can import neither the
 * settings kit nor its CSS (`.setk*` lives in the app's stylesheet, and the
 * host module table does not carry the kit), so a plugin-side copy would have
 * to invent its own dialect in the middle of a settings pane. And the row's
 * `data-setting` anchor is the settings-search contract: leaving it in a
 * bundle that can be a version behind the app means search offering to jump to
 * a row that is not there.
 */
export function ImportServerPicker() {
  const { session } = useServerSession();
  const targets = useImportTargets();
  const target = useImportServer();
  const peerSync = usePeerSyncStatus(target);
  const fault = importServerFault();
  // A pin this device can no longer honour. Silent until now: imports simply
  // ran on the signed-in box and the picker showed that box, so a choice that
  // had quietly lapsed looked exactly like a choice never made.
  const orphan = useOrphanedImportChoice();

  const health = target ? healthOf(target.url) : null;
  const band = health?.latencyMs != null ? latencyBand(health.latencyMs).label : null;
  const hint = target ? [importServerHost(target.url), band].filter(Boolean).join(' · ') : undefined;

  // A Select, not a SegmentedControl: the option count is one plus however
  // many other boxes this device knows, which is open-ended - and a segmented
  // control with 1fr columns stops fitting and starts overflowing without
  // warning somewhere around four.
  const options = targets.map((t) => ({
    value: t.url,
    label: t.primary ? `${t.label} (signed in)` : t.label,
  }));

  return (
    <PaneSection
      title="Where downloads run"
      description="Imports are fetched by one server and land in its library. Pick the box with the downloader installed — it copies finished songs across to your library afterwards, so both end up with the file."
      footer={pickerFooter(session, target, peerSync, fault, orphan)}
    >
      <SettingRow
        id="import-server"
        label="Download on"
        hint={hint}
        layout="stacked"
        // Disabled rather than hidden: a row that vanishes when it has nothing
        // to say teaches people the setting does not exist. With no mirrors it
        // still offers one option - the server you are on - which is the
        // honest answer, not an empty control.
        disabledReason={session ? undefined : 'Needs a server'}
        control={
          <Select
            aria-label="Download on"
            fullWidth
            value={target?.url ?? ''}
            options={options}
            onValueChange={(url) => {
              clearImportServerFault();
              // Storing null for the session server rather than its URL, so
              // signing into a different server moves imports with you instead
              // of leaving them pointed at the box you just left.
              setImportServerUrl(session && url === session.url ? null : url);
            }}
          />
        }
      />
    </PaneSection>
  );
}

/**
 * Everything the choice can currently be going wrong, as a footnote under the
 * group rather than a fake row: the copy-to-hub backlog, a stalled outbox, and
 * the one case that needs a decision - the chosen box rejecting this device.
 */
function pickerFooter(
  session: ServerSession | null,
  target: ServerSession | null,
  peerSync: PeerSyncStatus | null,
  fault: ImportServerFault | null,
  orphan: string | null,
): ReactNode {
  /*
   * A pin that lapsed, said out loud.
   *
   * Ahead of everything except a live rejection, because it changes what every
   * other line here MEANS: the copy-to-hub backlog below belongs to the box
   * imports are actually running on, which is not the one that was chosen.
   */
  if (orphan) {
    return (
      <Text tone="danger" size="xs">
        You chose {importServerHost(orphan)}, but this device has no sign-in for it any more, so
        imports are running on{' '}
        {target ? importServerHost(target.url) : 'the server you are signed into'}. Add it again
        under Settings, Servers, or pick a different box above.
      </Text>
    );
  }
  // A rejection is not routed around on purpose (see noteImportServerRejected):
  // the peer is usually the ONLY box with the downloader, so moving imports
  // silently would run them where they cannot possibly work.
  if (fault && target && fault.url === target.url) {
    return (
      <>
        <Text tone="danger" size="xs">
          {importServerHost(fault.url)} would not take the import: {fault.reason}
        </Text>
        {session && (
          <div className="prefsActions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                clearImportServerFault();
                setImportServerUrl(null);
              }}
            >
              Run imports on {importServerHost(session.url)} instead
            </Button>
          </div>
        )}
      </>
    );
  }

  // Not a peer, so there is no copy step to report - the songs land where they
  // were fetched and that is the whole story.
  if (!peerSync?.configured) return null;

  if (peerSync.stall) {
    return (
      <Text tone="danger" size="xs">
        Copying to {peerSync.hub} is stopped: {peerSync.stall.reason}
      </Text>
    );
  }

  if (peerSync.counts.failed > 0) {
    return (
      <Text tone="danger" size="xs">
        {peerSync.counts.failed} {peerSync.counts.failed === 1 ? 'song' : 'songs'} could not be
        copied to {peerSync.hub}. Settings &rarr; Server &rarr; Network has the list.
      </Text>
    );
  }

  const waiting = peerSync.counts.pending + peerSync.counts.uploading;
  if (waiting > 0) {
    return (
      <Text tone="muted" size="xs">
        {waiting} {waiting === 1 ? 'song' : 'songs'} waiting to copy to {peerSync.hub}.
      </Text>
    );
  }
  return (
    <Text tone="muted" size="xs">
      Finished songs are copied to {peerSync.hub} automatically.
    </Text>
  );
}
