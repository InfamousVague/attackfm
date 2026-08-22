// The same table the bell reads, so the switch list and the notification
// that arrives can never describe one kind in two vocabularies.
import { NOTICE_COPY as COPY, NOTICE_ORDER as ORDER } from '../notify/kinds.ts';
import { Button, Switch, Text } from '@glacier/react';
import { useCallback, useEffect, useState } from 'react';
import { fetchPushPrefs, setPushPref, type ServerSession } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { PaneSection, SettingRow, SettingsEmpty } from './kit/settingsKit.tsx';
import { osNoticesEnabled, setOsNotices, setVerboseNotices, verboseNoticesEnabled } from './behaviourPrefs.ts';
import { ensureOsNotifyPermission, sendTestNotification } from '../notify/osNotify.ts';

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

/*
 * The section list's one-line reading of this pane ("4 of 6 on") - cached at
 * module level because the list renders before this pane has ever mounted,
 * and the truth lives a fetch away on the server. The pane's own fetch and
 * the list's priming fetch both write it; whoever runs first wins, and they
 * cannot disagree because they read the same endpoint.
 */
let summaryCache: { key: string; text: string; at: number } | null = null;

/** Which account on which box wrote the cache - a multi-server app must not
 *  show one server's counts on another's row. */
function summaryKey(session: ServerSession): string {
  return `${session.url}\n${session.username}`;
}

function writeSummary(session: ServerSession, prefs: Record<string, boolean>): string {
  const kinds = Object.keys(prefs);
  const on = kinds.filter((k) => prefs[k] !== false).length;
  const text = `${on} of ${kinds.length} on`;
  summaryCache = { key: summaryKey(session), text, at: Date.now() };
  return text;
}

/** What the list shows now, or null before anything has been fetched FOR THIS
 *  session - another account's counts are worse than the worded fallback. */
export function notificationsSummaryCached(session: ServerSession): string | null {
  return summaryCache && summaryCache.key === summaryKey(session) ? summaryCache.text : null;
}

/** The list's light fetch on open. A minute of trust between fetches: opening
 *  settings twice in a row should not hit the server twice. */
export async function primeNotificationsSummary(session: ServerSession): Promise<string | null> {
  if (
    summaryCache &&
    summaryCache.key === summaryKey(session) &&
    Date.now() - summaryCache.at < 60_000
  ) {
    return summaryCache.text;
  }
  try {
    const r = await fetchPushPrefs(session);
    return writeSummary(session, r.prefs);
  } catch {
    return null;
  }
}

/**
 * The switches that belong to the PHONE rather than to the account.
 *
 * Rendered identically whether or not anyone is signed in, because neither of
 * these asks the server anything - which is exactly why they are the only part
 * of this pane a signed-out person can still use. It was two copies of the same
 * markup for that reason; one component keeps them one thing.
 */
function DeviceSection() {
  const [verbose, setVerbose] = useState(verboseNoticesEnabled);
  const [osOn, setOsOn] = useState(osNoticesEnabled);
  // Only ever set by an actual refusal. Before that it is not "denied", it is
  // "never asked" - and saying the former would be a lie on every desktop.
  const [refused, setRefused] = useState(false);
  // What the last test did, in the row's own words. Cleared when the switch
  // moves, because an old verdict beside a changed setting is a lie.
  const [tested, setTested] = useState<string | null>(null);

  return (
    <PaneSection
      title="On this device"
      description="Where the app's news is put, and how much of it there is. Both are about this phone rather than your account, so another device can answer differently."
    >
      <SettingRow
        id="notify-os"
        label="Show them on this device"
        hint={
          refused
            ? 'Your device is refusing notifications from AttackFM. Turn them back on for this app in the system settings, then flip this again.'
            : "Puts the same news in the notification tray, so it reaches you without the app open. Skipped while you are already looking at the app."
        }
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
            aria-label="Show notifications on this device"
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
          label="Send a test one"
          hint={
            tested ??
            'Puts one in the tray now, so you can see what arriving looks like before you rely on it.'
          }
          control={
            <Button
              variant="soft"
              size="sm"
              onClick={() => {
                setTested('Sending…');
                void sendTestNotification().then((r) => {
                  setTested(
                    r === 'sent'
                      ? 'Sent — look at your notifications.'
                      : r === 'refused'
                        ? 'Your device is refusing notifications from AttackFM. Turn them back on for this app in the system settings.'
                        : 'This build cannot reach the notification tray. Desktop and older installs need a fresh version of the app itself, not just an update.',
                  );
                  if (r === 'refused') setRefused(true);
                });
              }}
            >
              Send
            </Button>
          }
        />
      )}
      {/* Gates the local-only kinds (download started, stems, AI passes) raised
          by the client's own watchers; the server never sees them. */}
      <SettingRow
        id="notify-verbose"
        label="Verbose notifications"
        hint="Downloads starting, songs being pulled into stems, and the AI's background passes starting and finishing."
        control={
          <Switch
            checked={verbose}
            onCheckedChange={(v) => {
              setVerbose(v);
              setVerboseNotices(v);
            }}
            aria-label="Verbose notifications"
          />
        }
      />
    </PaneSection>
  );
}

export function NotificationSettings() {
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
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'could not load');
      });
    return () => ac.abort();
  }, [session]);

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
        setError('that did not save');
      });
    },
    [session],
  );

  if (!session) {
    return (
      <div className="prefsBody">
        <SettingsEmpty
          title="Notifications come from your server"
          body="Sign in and the switches appear — each kind is a per-account choice the server honours for every device at once."
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
      ? `Arriving on ${devices} registered ${devices === 1 ? 'device' : 'devices'}.`
      : 'No device is registered yet, so nothing can arrive however these are set.';

  return (
    <div className="prefsBody">
      <PaneSection
        title="What you are told about"
        description="Only a few things are worth interrupting somebody for. Each one switches off on its own, and it switches off for every device you have at once."
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
              Loading…
            </Text>
          </div>
        ) : (
          kinds.map((kind) => {
            const copy = COPY[kind] ?? { label: kind, hint: '' };
            return (
              <SettingRow
                key={kind}
                label={copy.label}
                hint={copy.hint || undefined}
                control={
                  <Switch
                    aria-label={copy.label}
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
