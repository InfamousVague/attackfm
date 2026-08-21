//! The log, on the device, in a form a thumb can hand over.
//!
//! Everything here exists because the person who needs this is holding a
//! phone: no console, no dev tools, and — until now — no way to say anything
//! more useful than "it says unreachable".
//!
//! Two ways out, because a phone will refuse one of them sooner or later.
//! `navigator.clipboard` needs a secure context and a user gesture, and in a
//! WKWebView it can simply not be there; when it is missing (or throws) the
//! report is still sitting in a read-only textarea, which is the one element
//! the app's global `user-select: none` deliberately exempts. Long-press,
//! Select All, Copy — the platform's own path, always available.

import { useEffect, useMemo, useState } from 'react';
import { Button, Text } from '@glacier/react';
import { Copy, Trash2 } from '@glacier/icons';
import { clearDiag, diagEntries, diagReport, subscribeDiag } from '../diag/diagLog.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { healthOf } from '../servers/mirrors.ts';
import { isAndroid, isIOS } from '../core/platform.ts';
import { isTauri } from '../core/tauri.ts';
import { pushDeviceToken } from '../core/notifications.ts';

/** Clock time, which is what someone comparing this against "it broke around
 *  ten past" actually needs; the copied report carries full ISO stamps. */
function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

export function DiagnosticsPane() {
  const { session } = useServerSession();
  const [, setTick] = useState(0);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'manual'>('idle');
  // The push pipeline's low-level truth, moved here from Notifications: a
  // person chasing a missing notification lands in Diagnostics, and "the
  // shell cannot mint a token" is a diagnosis, not a setting.
  const [pushToken, setPushToken] = useState<string | null | 'unknown'>('unknown');

  useEffect(() => subscribeDiag(() => setTick((n) => n + 1)), []);
  useEffect(() => {
    void pushDeviceToken().then((t) => setPushToken(t));
  }, []);

  const entries = diagEntries();
  const health = session ? healthOf(session.url) : null;

  // The header of the copied report. The server address is the single most
  // diagnostic line in it - an `http://` or a `:8788` that cannot work from a
  // phone is visible here and nowhere else the listener can reach.
  const report = useMemo(
    () =>
      diagReport({
        server: session ? session.url : 'not connected',
        reachable: health ? String(health.ok) : 'not probed yet',
        latency: health?.latencyMs != null ? `${Math.round(health.latencyMs)}ms` : '—',
        platform: isIOS ? 'ios' : isAndroid ? 'android' : isTauri() ? 'desktop' : 'browser',
        // Why a notification might never arrive, in one line: no token means
        // the shell cannot ask the OS for one (native work, per-platform);
        // a token that exists registers itself on the next sign-in.
        push:
          pushToken === 'unknown'
            ? 'probing'
            : pushToken === null
              ? 'no device token - the shell cannot mint one on this build'
              : 'device token held; registers on next sign-in',
      }),
    // Rebuilt on every recorded entry: `entries` is the ring itself, so its
    // identity changing is the signal that there is something new to say.
    [session, health, entries, pushToken],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied('ok');
    } catch {
      // No clipboard here. Not an error worth showing as one - the textarea
      // below already holds the same text, so just point at it.
      setCopied('manual');
    }
    window.setTimeout(() => setCopied('idle'), 4000);
  };

  return (
    <div className="diagPane">
      <Text tone="muted" size="sm">
        Every failure this device has hit recently — what could not be reached, and why. Kept on
        the device only; nothing here is sent anywhere.
      </Text>

      <div className="diagPane__actions">
        <Button variant="solid" size="sm" onClick={() => void copy()}>
          <Copy size={15} />
          <span>
            {copied === 'ok' ? 'Copied' : copied === 'manual' ? 'Select it below' : 'Copy report'}
          </span>
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => clearDiag()}
          disabled={entries.length === 0}
        >
          <Trash2 size={15} />
          <span>Clear</span>
        </Button>
      </div>

      {/* The always-available path. Read-only so nobody edits the evidence,
          but selectable — textarea is exempt from the app-wide selection
          block, which is the whole reason it is a textarea and not a <pre>. */}
      <textarea className="diagPane__report" readOnly value={report} spellCheck={false} />

      <div className="diagPane__list">
        {entries.length === 0 ? (
          <Text tone="muted" size="sm">
            Nothing recorded — everything this device has tried has worked.
          </Text>
        ) : (
          [...entries].reverse().map((e, i) => (
            <div key={`${e.at}-${i}`} className="diagRow">
              <span className="diagRow__time">{clockOf(e.at)}</span>
              <span className="diagRow__kind" data-kind={e.kind}>
                {e.kind}
              </span>
              <span className="diagRow__detail">{e.detail}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
