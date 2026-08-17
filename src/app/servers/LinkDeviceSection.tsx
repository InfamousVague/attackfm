import { Banner, Button, Field, Text } from '@glacier/react';
import { RefreshCw, Smartphone } from '@glacier/icons';
import { useCallback, useEffect, useState } from 'react';
import { pairStart } from '../server.ts';
import { pairPayload } from './pairing.ts';
import { useServerSession } from './serverSession.tsx';
import QRCode from 'qrcode';

/**
 * Link a device: mints a one-time code on the server this device is signed into
 * and shows it as a QR (and as text). A phone reads it - camera or typed - and
 * gets its own session with no password, the whole point being that nobody taps
 * a password into a phone. The code is short-lived; a countdown says so, and a
 * button mints a fresh one when it lapses.
 */
export function LinkDeviceSection() {
  const { session } = useServerSession();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mint = useCallback(async () => {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const { code, expiresIn } = await pairStart(session);
      const dataUrl = await QRCode.toDataURL(pairPayload(session.url, code), {
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 320,
        color: { dark: '#000000ff', light: '#ffffffff' },
      });
      setCode(code);
      setQr(dataUrl);
      setLeft(expiresIn);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create a code');
    } finally {
      setBusy(false);
    }
  }, [session]);

  // Count the code down to its expiry; a lapsed code stays on screen but greys
  // out, so the QR never silently becomes one that will be refused.
  useEffect(() => {
    if (left <= 0) return;
    const id = window.setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => window.clearInterval(id);
  }, [left]);

  const expired = code !== null && left <= 0;

  return (
    <div className="prefsSection">
      <Field
        label="Link a device"
        hint="Sign a phone in without typing a password: show a one-time code here and scan or enter it on the phone."
      >
        {!open ? (
          <div className="prefsActions">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setOpen(true);
                void mint();
              }}
            >
              <Smartphone size={14} /> Link a device
            </Button>
          </div>
        ) : (
          <div className="linkDevice">
            {qr && (
              <img
                className="linkDevice__qr"
                src={qr}
                alt="Pairing QR code"
                data-expired={expired || undefined}
              />
            )}
            {code && (
              <div className="linkDevice__code" aria-label="Pairing code">
                {code.length === 6 ? code.replace(/(.{3})(.{3})/, '$1 $2') : code}
              </div>
            )}
            {error && <Banner tone="danger">{error}</Banner>}
            <Text tone="muted" size="sm">
              {expired
                ? 'This code has expired.'
                : busy
                  ? 'Making a code…'
                  : `On the phone, open the sign-in screen → “Log in with a code”. Expires in ${left}s.`}
            </Text>
            <div className="prefsActions">
              <Button variant={expired ? 'solid' : 'ghost'} size="sm" disabled={busy} onClick={() => void mint()}>
                <RefreshCw size={14} /> New code
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Field>
    </div>
  );
}
