// The same table the bell reads, so the switch list and the notification
// that arrives can never describe one kind in two vocabularies.
import { NOTICE_COPY as COPY, NOTICE_ORDER as ORDER } from '../notify/kinds.ts';
import { Button, Switch, Text } from '@glacier/react';
import { useCallback, useEffect, useState } from 'react';
import { fetchPushPrefs, setPushPref } from '../server.ts';
import { writeSummary } from './notificationsSummary.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { PaneSection, SettingRow, SettingsEmpty } from './kit/settingsKit.tsx';
import { discoveryNoticesEnabled, osNoticesEnabled, setDiscoveryNotices, setOsNotices, setVerboseNotices, verboseNoticesEnabled } from './behaviourPrefs.ts';
import { ensureOsNotifyPermission, sendTestNotification } from '../notify/osNotify.ts';
import { useT } from '../i18n/LocaleShell.tsx';

/**
 * What the app is allowed to interrupt you for.
 *
 * The switches are per-account and live on the server, because the decision
 * belongs to the listener rather than to whichever phone they happen to be
 * holding - and because the server is what decides not to send.
 *
 * The kinds themselves come from the server too. It answers with every kind it
 * knows and where this account stands on each, so a kind added there appears
 * here without an app release; the copy below is a lookup, and an unknown kind
 * falls back to its own id rather than vanishing.
 */

/**
 * The switches that belong to the PHONE rather than to the account.
 *
 * Rendered identically whether or not anyone is signed in, because neither of
 * these asks the server anything - which is exactly why they are the only part
 * of this pane a signed-out person can still use. It was two copies of the same
 * markup for that reason; one component keeps them one thing.
 */
function DeviceSection() {
  const t = useT();
  const [verbose, setVerbose] = useState(verboseNoticesEnabled);
  const [discovery, setDiscovery] = useState(discoveryNoticesEnabled);
  const [osOn, setOsOn] = useState(osNoticesEnabled);
  // Only ever set by an actual refusal. Before that it is not "denied", it is
  // "never asked" - and saying the former would be a lie on every desktop.
  const [refused, setRefused] = useState(false);
  // What the last test did, in the row's own words. Cleared when the switch
  // moves, because an old verdict beside a changed setting is a lie.
  const [tested, setTested] = useState<string | null>(null);

  return (
    <PaneSection
      title={t('settings.notifyDevice')}
      description={t('settings.notifyDeviceHint')}
    >
      <SettingRow
        id="notify-os"
        label={t('settings.notifyOs')}
        hint={refused ? t('settings.notifyRefusedFlip') : t('settings.notifyOsHint')}
        control={
          <Switch
            checked={osOn}
            onCheckedChange={(v) => {
              setOsOn(v);
              setOsNotices(v);
              setTested(null);
              // Asked HERE as well as at the first notice, because turning a
              // switch on is the clearest possible moment to be asked - and
              // finding out then beats finding out by nothing arriving.
              if (v) void ensureOsNotifyPermission().then((ok) => setRefused(!ok));
              else setRefused(false);
            }}
            aria-label={t('settings.notifyOsAria')}
          />
        }
      />
      {/* Because the honest answer to "will these actually arrive?" is one the
          app can demonstrate rather than promise. Three things have to line up
          for it to work - a binary with the plugin, the OS permission, and this
          switch - and only one of them is visible from here. */}
      {osOn && (
        <SettingRow
          id="notify-os-test"
          label={t('settings.notifyTest')}
          hint={tested ?? t('settings.notifyTestHint')}
          control={
            <Button
              variant="soft"
              size="sm"
              onClick={() => {
                setTested(t('settings.notifyTestSending'));
                void sendTestNotification().then((r) => {
                  setTested(
                    r === 'sent'
                      ? t('settings.notifyTestSent')
                      : r === 'refused'
                        ? t('settings.notifyRefused')
                        : t('settings.notifyTestUnsupported'),
                  );
                  if (r === 'refused') setRefused(true);
                });
              }}
            >
              {t('settings.notifyTestSend')}
            </Button>
          }
        />
      )}
      {/* The app's own discovery work, as news. On by default: the whole point
          is that the silent shelf-building should reach you, and the watchers
          are already seed-silent and rise-only, so this is for the person who
          simply does not want it rather than a noise guard. Local-only, so it
          is not in the account's switch list above. */}
      <SettingRow
        id="notify-discovery"
        label={t('settings.notifyDiscovery')}
        hint={t('settings.notifyDiscoveryHint')}
        control={
          <Switch
            checked={discovery}
            onCheckedChange={(v) => {
              setDiscovery(v);
              setDiscoveryNotices(v);
            }}
            aria-label={t('settings.notifyDiscovery')}
          />
        }
      />
      {/* Gates the local-only kinds (download started, stems, AI passes) raised
          by the client's own watchers; the server never sees them. */}
      <SettingRow
        id="notify-verbose"
        label={t('settings.notifyVerbose')}
        hint={t('settings.notifyVerboseHint')}
        control={
          <Switch
            checked={verbose}
            onCheckedChange={(v) => {
              setVerbose(v);
              setVerboseNotices(v);
            }}
            aria-label={t('settings.notifyVerbose')}
          />
        }
      />
    </PaneSection>
  );
}

export function NotificationSettings() {
  const t = useT();
  const { session } = useServerSession();
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [devices, setDevices] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const ac = new AbortController();
    fetchPushPrefs(session, ac.signal)
      .then((r) => {
        setPrefs(r.prefs);
        setDevices(r.devices);
        setError(null);
        writeSummary(session, r.prefs);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : t('settings.notifyLoadFailed'));
      });
    return () => ac.abort();
  }, [session, t]);

  const flip = useCallback(
    (kind: string, enabled: boolean) => {
      if (!session) return;
      // Moved at once and reconciled only on failure: a switch that waits for
      // a round trip feels broken on a phone with a slow link.
      setPrefs((p) => {
        const next = { ...(p ?? {}), [kind]: enabled };
        writeSummary(session, next);
        return next;
      });
      setPushPref(session, kind, enabled).catch(() => {
        setPrefs((p) => {
          const next = { ...(p ?? {}), [kind]: !enabled };
          writeSummary(session, next);
          return next;
        });
        setError(t('settings.notifySaveFailed'));
      });
    },
    [session, t],
  );

  if (!session) {
    return (
      <div className="prefsBody">
        <SettingsEmpty
          title={t('settings.notifySignedOut')}
          body={t('settings.notifySignedOutBody')}
        />
      <DeviceSection />
      </div>
    );
  }

  const kinds = prefs
    ? [...Object.keys(prefs)].sort((a, b) => {
        const ia = ORDER.indexOf(a);
        const ib = ORDER.indexOf(b);
        return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
      })
    : [];

  /*
   * The pipeline's honest state, demoted from a whole section to one line
   * under the switches: registered devices is the single number that says
   * whether anything can arrive at all, and one sentence carries it. The
   * token-level diagnosis of WHY nothing is registered belongs to
   * Diagnostics, where somebody chasing a missing notification will look.
   */
  const pipeline =
    devices > 0
      ? t('settings.notifyArriving', { count: devices })
      : t('settings.notifyNoDevices');

  return (
    <div className="prefsBody">
      <PaneSection
        title={t('settings.notifyKinds')}
        description={t('settings.notifyKindsHint')}
        footer={pipeline}
      >
        {error && (
          <div className="setk-row">
            <Text size="xs" tone="danger">
              {error}
            </Text>
          </div>
        )}
        {prefs === null && !error ? (
          <div className="setk-row">
            <Text size="sm" tone="subtle">
              {t('common.loading')}
            </Text>
          </div>
        ) : (
          kinds.map((kind) => {
            // The table names each kind by KEY, so the words are picked here,
            // in a render that re-runs when the language does. A kind the
            // table has never heard of still shows its own id, as before.
            const copy = COPY[kind];
            const label = copy ? t(copy.labelKey) : kind;
            const hint = copy ? t(copy.hintKey) : '';
            return (
              <SettingRow
                key={kind}
                label={label}
                hint={hint || undefined}
                control={
                  <Switch
                    aria-label={label}
                    checked={prefs?.[kind] ?? true}
                    onCheckedChange={(v: boolean) => flip(kind, v)}
                  />
                }
              />
            );
          })
        )}
      </PaneSection>
      <DeviceSection />
    </div>
  );
}
