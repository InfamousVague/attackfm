import { Button, Drawer } from '@glacier/react';
import { Check, Copy, Download, Share2 } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useServerSession } from '../servers/serverSession.tsx';
import { shoot } from '../widget/shot.ts';
import logo from '../../assets/attack-white.png';

/**
 * "Invite a friend" - a card that tells someone with no account how to get on
 * THIS server, and downloads as a picture you can send them.
 *
 * Self-hosting only pays off when the people you listen with are on the box
 * too, and the hardest part of that has always been explaining it: the app,
 * the address, the account, in the right order. So the card says exactly that
 * in three steps, wears a QR of the server's address for a camera to skip the
 * typing, and - because a link in a chat gets lost but a picture gets saved -
 * turns itself into a PNG on a tap.
 *
 * The picture IS this card. widget/shot.ts rasterises the real node with the
 * app's own stylesheet, so what saves is pixel-for-pixel what the drawer shows
 * - no second poster to keep in step. That is also why the card is painted on
 * solid gradients rather than a blur: a backdrop-filter has no backdrop inside
 * the shot and would come out empty.
 */

/** The address a person types or scans - the server's own origin, no path. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

function InviteCard({
  cardRef,
  host,
  qr,
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  host: string;
  qr: string | null;
}) {
  return (
    <div className="inviteCard" ref={cardRef}>
      <div className="inviteCard__head">
        <img className="inviteCard__logo" src={logo} alt="AttackFM" />
        <span className="inviteCard__kicker">You're invited</span>
      </div>

      <h2 className="inviteCard__title">Come listen on my server</h2>
      <p className="inviteCard__sub">
        Your own music and audiobooks, streamed from a box at home. One account, every device.
      </p>

      <div className="inviteCard__qrWrap">
        {qr ? (
          <img className="inviteCard__qr" src={qr} alt={`QR code for ${host}`} />
        ) : (
          <div className="inviteCard__qr" aria-hidden />
        )}
      </div>

      <span className="inviteCard__addrLabel">Server address</span>
      <p className="inviteCard__addr">{host}</p>

      <ol className="inviteCard__steps">
        <li className="inviteCard__step">
          <span className="inviteCard__n">1</span>
          <span>
            Get the app — <b>attack.fm</b>, or open this address in any browser.
          </span>
        </li>
        <li className="inviteCard__step">
          <span className="inviteCard__n">2</span>
          <span>
            Add a server — scan the code, or type <b>{host}</b>.
          </span>
        </li>
        <li className="inviteCard__step">
          <span className="inviteCard__n">3</span>
          <span>Create your account, and you're in.</span>
        </li>
      </ol>

      <p className="inviteCard__foot">attack.fm</p>
    </div>
  );
}

export function ShareServer() {
  const { session } = useServerSession();
  const [open, setOpen] = useState(false);
  const [qr, setQr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const host = session ? hostOf(session.url) : '';

  // The QR is the server's address, plain https - a camera opens it in a
  // browser, which lands a newcomer on the sign-up the card describes. Built
  // when the drawer opens (and only then) so a library that never shares one
  // pays nothing for the encode.
  useEffect(() => {
    if (!open || !session) return;
    let live = true;
    void QRCode.toDataURL(session.url, {
      margin: 0,
      width: 300,
      color: { dark: '#101014ff', light: '#ffffffff' },
    })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        // No QR is a card with a blank tile and the address in words - still
        // an invite, just one that has to be typed.
      });
    return () => {
      live = false;
    };
  }, [open, session]);

  // Nothing to invite anyone TO without a server: a local-only library has no
  // address to hand out, so the button simply is not there.
  if (!session) return null;

  const copyAddress = () => {
    void navigator.clipboard?.writeText(host).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
      },
      () => {},
    );
  };

  const saveImage = async () => {
    const node = cardRef.current;
    if (!node || saving) return;
    setSaving(true);
    try {
      // Three device pixels per CSS pixel: the card is designed small and
      // rasterised large, so the picture is sharp rather than a blown-up
      // screenshot. See widget/shot.ts on why the scale lives here.
      const dataUrl = await shoot(node, 320, 560, 3);
      if (!dataUrl) return;
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], 'attackfm-invite.png', { type: 'image/png' });
      // On a phone the native share sheet is the right home for this - it
      // carries "Save image" AND every messenger the person might send it
      // through. Where it cannot take a file (desktop, most browsers), a plain
      // download is the honest fallback.
      const shareData = { files: [file], title: 'Join me on AttackFM' };
      if (navigator.canShare?.(shareData)) {
        try {
          await navigator.share(shareData);
          return;
        } catch {
          // A cancelled share is not a failure; fall through to the download
          // only if the sheet never opened. A user backing out lands here too,
          // so the download is a second chance rather than a surprise file.
          return;
        }
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'attackfm-invite.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="libraryInvite">
        <Button variant="soft" size="sm" onClick={() => setOpen(true)}>
          <Share2 size={15} />
          Invite a friend
        </Button>
      </div>

      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        side="bottom"
        size="lg"
        title="Invite a friend"
        description="Share how to join your server."
        className="inviteSheet"
      >
        <InviteCard cardRef={cardRef} host={host} qr={qr} />

        <div className="inviteSheet__actions">
          <Button variant="ghost" onClick={copyAddress}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? 'Copied' : 'Copy address'}
          </Button>
          <Button variant="solid" onClick={() => void saveImage()} disabled={saving}>
            <Download size={16} />
            {saving ? 'Saving…' : 'Save image'}
          </Button>
        </div>
      </Drawer>
    </>
  );
}
