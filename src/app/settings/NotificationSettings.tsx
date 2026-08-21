// The same table the bell reads, so the switch list and the notification
// that arrives can never describe one kind in two vocabularies.
import { NOTICE_COPY as COPY, NOTICE_ORDER as ORDER } from '../notify/kinds.ts';
import { Switch, Text } from '@glacier/react';
import { useCallback, useEffect, useState } from 'react';
import { fetchPushPrefs, setPushPref, type ServerSession } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { PaneSection, SettingRow, SettingsEmpty } from './kit/settingsKit.tsx';
import { setVerboseNotices, verboseNoticesEnabled } from './behaviourPrefs.ts';

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

export function NotificationSettings() {
  // Device-local, unlike every switch below it: how much THIS phone rings
  // for background work is not a fact about the account.
  const [verbose, setVerbose] = useState(verboseNoticesEnabled);
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
      {/* The one switch here that lives on the device rather than the server.
          It gates the local-only kinds (download started, stems, AI passes)
          raised by the client's own watchers; the server never sees them. */}
      <PaneSection
        title="On this device"
        description="Normally only news rings the bell. Turn this on to hear about the machinery working too."
      >
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
      {/* The one switch here that lives on the device rather than the server.
          It gates the local-only kinds (download started, stems, AI passes)
          raised by the client's own watchers; the server never sees them. */}
      <PaneSection
        title="On this device"
        description="Normally only news rings the bell. Turn this on to hear about the machinery working too."
      >
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
    </div>
  );
}
