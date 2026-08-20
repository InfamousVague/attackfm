// The same table the bell reads, so the switch list and the notification
// that arrives can never describe one kind in two vocabularies.
import { NOTICE_COPY as COPY, NOTICE_ORDER as ORDER } from '../notify/kinds.ts';
import { Label, Switch, Text } from '@glacier/react';
import { useCallback, useEffect, useState } from 'react';
import { fetchPushPrefs, setPushPref } from '../server.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { pushDeviceToken } from '../core/notifications.ts';

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


export function NotificationSettings() {
  const { session } = useServerSession();
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null);
  const [devices, setDevices] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);

  useEffect(() => {
    if (!session) return;
    const ac = new AbortController();
    fetchPushPrefs(session, ac.signal)
      .then((r) => {
        setPrefs(r.prefs);
        setDevices(r.devices);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'could not load');
      });
    void pushDeviceToken().then(setToken);
    return () => ac.abort();
  }, [session]);

  const flip = useCallback(
    (kind: string, enabled: boolean) => {
      if (!session) return;
      // Moved at once and reconciled only on failure: a switch that waits for
      // a round trip feels broken on a phone with a slow link.
      setPrefs((p) => ({ ...(p ?? {}), [kind]: enabled }));
      setPushPref(session, kind, enabled).catch(() => {
        setPrefs((p) => ({ ...(p ?? {}), [kind]: !enabled }));
        setError('that did not save');
      });
    },
    [session],
  );

  if (!session) {
    return (
      <Text size="sm" tone="muted">
        Notifications come from your server, so this needs one. Sign in and the switches appear.
      </Text>
    );
  }

  const kinds = prefs
    ? [...Object.keys(prefs)].sort((a, b) => {
        const ia = ORDER.indexOf(a);
        const ib = ORDER.indexOf(b);
        return (ia < 0 ? ORDER.length : ia) - (ib < 0 ? ORDER.length : ib);
      })
    : [];

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Label>What you are told about</Label>
        <Text size="sm" tone="muted">
          Only a few things are worth interrupting somebody for. Each one switches off on its
          own, and it switches off for every device you have at once.
        </Text>
        {error && (
          <Text size="xs" tone="danger">
            {error}
          </Text>
        )}
        {prefs === null && !error ? (
          <Text size="sm" tone="subtle">
            Loading…
          </Text>
        ) : (
          kinds.map((kind) => {
            const copy = COPY[kind] ?? { label: kind, hint: '' };
            return (
              <div className="notifyKind" key={kind}>
                <Switch
                  label={copy.label}
                  checked={prefs?.[kind] ?? true}
                  onCheckedChange={(v: boolean) => flip(kind, v)}
                />
                {copy.hint && (
                  <Text size="xs" tone="subtle">
                    {copy.hint}
                  </Text>
                )}
              </div>
            );
          })
        )}
      </div>

      {/*
        The honest state of the pipeline, rather than a pane of switches that
        quietly govern nothing. Registered devices is the one number that says
        whether anything can arrive at all: with none, every switch above is a
        preference for a message that has nowhere to go.
      */}
      <div className="prefsSection">
        <Label>Where they arrive</Label>
        {devices > 0 ? (
          <Text size="sm" tone="muted">
            {devices} {devices === 1 ? 'device is' : 'devices are'} registered to receive them.
          </Text>
        ) : (
          <>
            <Text size="sm" tone="muted">
              No device is registered yet, so nothing can arrive however these are set.
            </Text>
            <Text size="xs" tone="subtle">
              {token === null
                ? 'This build cannot ask iOS for a notification token yet - that part is native, and needs Push Notifications enabled on the app id first.'
                : 'This device has a token but has not registered it; it will on the next sign-in.'}
            </Text>
          </>
        )}
      </div>
    </div>
  );
}
