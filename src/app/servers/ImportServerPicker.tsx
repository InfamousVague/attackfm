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
  importServerIsAutomatic,
} from './importServer.ts';
import { usePeerSyncStatus, type PeerSyncStatus } from './peerSyncStatus.ts';
import { useT } from '../i18n/LocaleShell.tsx';
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
  const t = useT();
  const { session } = useServerSession();
  const targets = useImportTargets();
  const target = useImportServer();
  const peerSync = usePeerSyncStatus(target);
  const fault = importServerFault();
  // A pin this device can no longer honour. Silent until now: imports simply
  // ran on the signed-in box and the picker showed that box, so a choice that
  // had quietly lapsed looked exactly like a choice never made.
  const orphan = useOrphanedImportChoice();
  // Worked out rather than chosen, because the signed-in box said it does not
  // download. Said out loud: a setting nobody touched that is not on its
  // default is otherwise indistinguishable from one somebody set and forgot.
  const automatic = importServerIsAutomatic(session);

  const health = target ? healthOf(target.url) : null;
  const band = health?.latencyMs != null ? latencyBand(health.latencyMs).label : null;
  const hint = target ? [importServerHost(target.url), band].filter(Boolean).join(' · ') : undefined;

  // A Select, not a SegmentedControl: the option count is one plus however
  // many other boxes this device knows, which is open-ended - and a segmented
  // control with 1fr columns stops fitting and starts overflowing without
  // warning somewhere around four.
  const options = targets.map((box) => ({
    value: box.url,
    label: box.primary ? t('servers.importTargetSignedIn', { label: box.label }) : box.label,
  }));

  return (
    <PaneSection
      title={t('servers.whereDownloadsRun')}
      description={t('servers.whereDownloadsRunHint')}
      footer={pickerFooter(t, session, target, peerSync, fault, orphan, automatic)}
    >
      <SettingRow
        id="import-server"
        label={t('servers.downloadOn')}
        hint={hint}
        layout="stacked"
        // Disabled rather than hidden: a row that vanishes when it has nothing
        // to say teaches people the setting does not exist. With no mirrors it
        // still offers one option - the server you are on - which is the
        // honest answer, not an empty control.
        disabledReason={session ? undefined : t('servers.needsAServer')}
        control={
          <Select
            aria-label={t('servers.downloadOn')}
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
 *
 * Takes the translator as an argument rather than calling useT() itself: it is
 * a plain function called from the picker's render, not a component, so a hook
 * here would fire outside React's accounting on the branches that return null.
 */
function pickerFooter(
  t: ReturnType<typeof useT>,
  session: ServerSession | null,
  target: ServerSession | null,
  peerSync: PeerSyncStatus | null,
  fault: ImportServerFault | null,
  orphan: string | null,
  automatic: boolean,
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
        {t('servers.importChoiceOrphaned', {
          chosen: importServerHost(orphan),
          running: target ? importServerHost(target.url) : t('servers.theSignedInServer'),
        })}
      </Text>
    );
  }
  if (automatic && target) {
    return (
      <Text tone="muted" size="xs">
        {t('servers.importChoiceAutomatic', { host: importServerHost(target.url) })}
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
          {t('servers.importRejected', {
            host: importServerHost(fault.url),
            reason: fault.reason,
          })}
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
              {t('servers.importRunHereInstead', { host: importServerHost(session.url) })}
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
        {t('servers.copyStopped', { hub: peerSync.hub, reason: peerSync.stall.reason })}
      </Text>
    );
  }

  if (peerSync.counts.failed > 0) {
    return (
      <Text tone="danger" size="xs">
        {t('servers.copyFailed', { count: peerSync.counts.failed, hub: peerSync.hub })}
      </Text>
    );
  }

  const waiting = peerSync.counts.pending + peerSync.counts.uploading;
  if (waiting > 0) {
    return (
      <Text tone="muted" size="xs">
        {t('servers.copyWaiting', { count: waiting, hub: peerSync.hub })}
      </Text>
    );
  }
  return (
    <Text tone="muted" size="xs">
      {t('servers.copyIdle', { hub: peerSync.hub })}
    </Text>
  );
}
