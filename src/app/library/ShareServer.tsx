import { Button, IconButton, Text, useToast } from '@glacier/react';
import { GlassSheet } from '../ux/GlassSheet.tsx';
import { Check, Copy, Download, RefreshCw, Share2 } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { createInvite, inviteLink } from '../servers/registry.ts';
import { shoot } from '../widget/shot.ts';
import logo from '../../assets/attack-white.png';

/**
 * "Invite a friend" - a card that tells someone with no account how to get on
 * THIS server, and downloads as a picture you can send them.
 *
 * The card is built around a REAL invite, minted on the registry the moment
 * the drawer opens, because the real way onto a server is the invite code -
 * not the address. And it tells the steps in the order the app actually
 * walks them (see servers/JoinServer.tsx): first the app and a free AttackFM
 * account, which works on every server; then the code, scanned or typed, which
 * is what lets that account into this one. A card that led with the address
 * described a door that does not exist.
 *
 * The QR is the invite link itself. A camera opens it on the registry's
 * landing page (the server's name, an "Open in AttackFM" button, the code in
 * plain text); a phone that already has the app deep-links straight into the
 * join screen with the code filled in. The code is printed large beside it
 * for anyone who would rather type.
 *
 * The picture IS this card. widget/shot.ts rasterises the real node with the
 * app's own stylesheet, so what saves is pixel-for-pixel what the drawer shows
 * - no second poster to keep in step. That is also why the card is painted on
 * solid gradients rather than a blur: a backdrop-filter has no backdrop inside
 * the shot and would come out empty.
 */

/** "ABC 123" - the code in two halves, the way the app's own join screen and
 *  the registry's landing page both print it, so a reader's eye and thumb
 *  meet the same shape everywhere. */
function splitCode(code: string): string {
  const mid = Math.ceil(code.length / 2);
  return `${code.slice(0, mid)} ${code.slice(mid)}`;
}

/** Whose server this is, for the title. The username is the one thing about
 *  the account a friend will recognise; a server with no name on it is just
 *  a URL. */
function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

/** Invites expire; a PNG does not. The card says until when, so a stale
 *  picture explains its own dead code. The registry stamps milliseconds; a
 *  seconds stamp is tolerated in case that ever changes under us. */
function untilLabel(expiresAt: number): string {
  // 0 is the registry's mark for a standing invite: no expiry, and not used up
  // by the first person through, so one card can admit a whole group.
  if (expiresAt === 0) return 'code never expires';
  const ms = expiresAt < 1e12 ? expiresAt * 1000 : expiresAt;
  return `code valid until ${new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

/** The lifetimes on offer. Seconds, or 0 for a standing (never-expiring,
 *  reusable) code. A week is the registry's own default and the middle seat. */
const LIVES: { label: string; ttl: number }[] = [
  { label: '1 day', ttl: 24 * 3600 },
  { label: '1 week', ttl: 7 * 24 * 3600 },
  { label: '1 month', ttl: 30 * 24 * 3600 },
  { label: 'Never expires', ttl: 0 },
];

interface Invite {
  code: string;
  expiresAt: number;
}

function InviteCard({
  cardRef,
  owner,
  invite,
  qr,
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  owner: string;
  invite: Invite;
  qr: string | null;
}) {
  return (
    <div className="inviteCard" ref={cardRef}>
      <div className="inviteCard__head">
        <img className="inviteCard__logo" src={logo} alt="AttackFM" />
        <span className="inviteCard__kicker">You're invited</span>
      </div>

      <h2 className="inviteCard__title">Join {possessive(owner)} Server</h2>
      <p className="inviteCard__sub">
        Music and audiobooks, streamed from a box at home. One free account, every device.
      </p>

      <div className="inviteCard__qrWrap">
        {qr ? (
          <img className="inviteCard__qr" src={qr} alt={`Invite code ${invite.code}`} />
        ) : (
          <div className="inviteCard__qr" aria-hidden />
        )}
      </div>

      <span className="inviteCard__addrLabel">Invite code</span>
      <p className="inviteCard__addr inviteCard__code">{splitCode(invite.code)}</p>

      <ol className="inviteCard__steps">
        <li className="inviteCard__step">
          <span className="inviteCard__n">1</span>
          <span>
            Get the app at <b>attack.fm</b> and create your free AttackFM account.
          </span>
        </li>
        <li className="inviteCard__step">
          <span className="inviteCard__n">2</span>
          <span>
            Scan this code, or enter <b>{splitCode(invite.code)}</b> under Join a server — and
            you're in.
          </span>
        </li>
      </ol>

      <p className="inviteCard__foot">attack.fm · {untilLabel(invite.expiresAt)}</p>
    </div>
  );
}

/**
 * Lives in the header, at the bell's right hand - one glyph, no caption, the
 * way the bell itself is. `iconSize` matches whichever chrome mounts it.
 */
export function ShareServer({ iconSize = 20 }: { iconSize?: number }) {
  const { session } = useServerSession();
  const { toast } = useToast();
  const registry = useRegistryOptional();
  const [open, setOpen] = useState(false);
  const [invite, setInvite] = useState<Invite | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [life, setLife] = useState<number>(7 * 24 * 3600);
  const cardRef = useRef<HTMLDivElement | null>(null);

  const identity = registry?.session ?? null;
  const owner = session?.username?.trim() || 'my';

  /*
   * Mint the invite when the drawer opens, once - then reuse it for as long as
   * this page lives, so opening the drawer twice does not litter the registry
   * with codes. "New code" below is the deliberate way to mint another. Any
   * member may mint; the server checks the code with the registry when it is
   * spent, so a code on a picture is no more power than a code in a message.
   */
  const mint = async (ttl: number = life) => {
    if (!identity || !session || minting) return;
    setMinting(true);
    setMintError(null);
    try {
      const made = await createInvite(
        identity.token,
        session.url,
        session.username ? `${session.username}'s AttackFM` : 'AttackFM',
        ttl === 0 ? { standing: true } : { ttlSecs: ttl },
      );
      setInvite({ code: made.code, expiresAt: made.expiresAt });
      setCopied(false);
    } catch (err) {
      setMintError(err instanceof Error ? err.message : 'Could not make an invite right now.');
    } finally {
      setMinting(false);
    }
  };
  useEffect(() => {
    if (open && !invite && !minting && identity && session) void mint();
    // Fire on open only; the guards above keep it from double-minting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, identity, session]);

  // The QR carries the invite LINK - the same string the share button in
  // Profile hands out - so a camera and a typed code arrive at the same door.
  useEffect(() => {
    if (!invite) {
      setQr(null);
      return;
    }
    let live = true;
    void QRCode.toDataURL(inviteLink(invite.code), {
      margin: 0,
      width: 1000,
      color: { dark: '#101014ff', light: '#ffffffff' },
    })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        // No QR is a card with a blank tile and the code in words - still an
        // invite, just one that has to be typed.
      });
    return () => {
      live = false;
    };
  }, [invite]);

  // Nothing to invite anyone TO without a server: a local-only library has no
  // door to hand out, so the button simply is not there.
  if (!session) return null;

  const link = invite ? inviteLink(invite.code) : null;

  const copyLink = () => {
    if (!link) return;
    void navigator.clipboard?.writeText(link).then(
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
      // At the size it is actually drawn - the card is fluid up to its cap,
      // so a hardcoded pair would photograph a narrow phone's card wrong.
      const box = node.getBoundingClientRect();
      // Five device pixels per CSS pixel: a ~400px card becomes a ~2000px
      // poster, sharp on any screen it is sent to. The QR below is rendered
      // at 1000px for the same reason - a 300px code scaled up came out soft.
      const dataUrl = await shoot(node, Math.round(box.width), Math.round(box.height), 5);
      if (!dataUrl) {
        toast({ message: 'Could not draw the card. Try again in a moment.' });
        return;
      }
      /*
       * Where it goes, in order of what actually works:
       *  1. Android: the native bridge writes it into Photos (Pictures/AttackFM)
       *     through MediaStore. A WebView has no Web Share API for files and
       *     ignores an anchor's download, so without this the button did
       *     nothing at all - which is exactly what got reported.
       *  2. iOS and modern browsers: the share sheet, which carries "Save
       *     Image" and every messenger.
       *  3. Desktop and the rest: a plain download.
       */
      const native = (window as unknown as {
        AFMNative?: { saveImage?: (base64: string, name: string) => boolean };
      }).AFMNative;
      if (native?.saveImage) {
        const ok = native.saveImage(dataUrl.slice(dataUrl.indexOf(',') + 1), 'attackfm-invite.png');
        toast({
          message: ok
            ? 'Saved to Photos, in the AttackFM album.'
            : 'Could not save the picture. Check storage access in Settings.',
        });
        return;
      }
      const blob = await (await fetch(dataUrl)).blob();
      const file = new File([blob], 'attackfm-invite.png', { type: 'image/png' });
      const shareData = { files: [file], title: `Join ${possessive(owner)} AttackFM server` };
      if (navigator.canShare?.(shareData)) {
        try {
          await navigator.share(shareData);
        } catch {
          // A cancelled sheet is a decision, not a failure - no surprise file.
        }
        return;
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'attackfm-invite.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast({ message: 'Downloaded attackfm-invite.png.' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <IconButton
        variant="ghost"
        aria-label="Invite a friend"
        title="Invite a friend"
        onClick={() => setOpen(true)}
      >
        <Share2 size={iconSize} />
      </IconButton>

      <GlassSheet open={open} onClose={() => setOpen(false)} label="Invite a friend" className="inviteSheet">
        <h2 className="inviteSheet__title">Invite a friend</h2>
        <p className="inviteSheet__desc">Share how to join {possessive(owner)} server.</p>
        {identity && (
          <div className="inviteSheet__life" role="radiogroup" aria-label="How long the code lasts">
            <span className="inviteSheet__lifeLabel">Code lasts</span>
            {LIVES.map((l) => (
              <Button
                key={l.ttl}
                size="sm"
                variant={life === l.ttl ? 'solid' : 'ghost'}
                aria-pressed={life === l.ttl}
                disabled={minting}
                onClick={() => {
                  if (life === l.ttl) return;
                  setLife(l.ttl);
                  // A different life is a different code.
                  void mint(l.ttl);
                }}
              >
                {l.label}
              </Button>
            ))}
          </div>
        )}
        {!identity ? (
          /* An invite is minted against an AttackFM account, and this device
             has none yet. Say where to get one rather than offering a card
             with no code on it. */
          <Text tone="muted" className="inviteSheet__note">
            Invites come from your AttackFM account, and this device is not signed into one
            yet. Create it under Profile → Friends — it is free and works on every server —
            then come back here.
          </Text>
        ) : mintError ? (
          <Text tone="danger" className="inviteSheet__note">
            {mintError}
          </Text>
        ) : !invite ? (
          <Text tone="muted" className="inviteSheet__note">
            Making your invite…
          </Text>
        ) : (
          <InviteCard cardRef={cardRef} owner={owner} invite={invite} qr={qr} />
        )}

        {identity && (
          <div className="inviteSheet__actions">
            <Button variant="ghost" onClick={copyLink} disabled={!link}>
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button variant="solid" onClick={() => void saveImage()} disabled={saving || !invite}>
              <Download size={16} />
              {saving ? 'Saving…' : 'Save image'}
            </Button>
          </div>
        )}
        {identity && invite && (
          <Button variant="ghost" size="sm" onClick={() => void mint()} disabled={minting}>
            <RefreshCw size={14} />
            {minting ? 'Making…' : 'New code'}
          </Button>
        )}
      </GlassSheet>
    </>
  );
}
