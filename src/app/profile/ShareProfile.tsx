import { Button, Text, useToast } from '@glacier/react';
import { Check, Copy, Download, UserRound } from '@glacier/icons';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import QRCode from 'qrcode';
import { GlassSheet } from '../ux/GlassSheet.tsx';
import { profileLink } from '../servers/registry.ts';
import { shoot } from '../widget/shot.ts';
import { saveCardImage } from '../widget/saveCard.ts';
import logo from '../../assets/attack-white.png';

/**
 * "Share your profile" - your handle as a link, on the card a playlist and a
 * jam already wear.
 *
 * WHAT THE LINK LEADS TO IS AN INTRODUCTION, NOT A WINDOW. Profiles on the
 * registry are friends-only and stay that way - what somebody listens to is
 * theirs. The page behind this link shows the handle and the pictures, and
 * offers the app; the listening only opens once you are friends. So this is
 * shareable in public without publishing anything, which is the only way a
 * profile link is worth having.
 *
 * THERE IS NOTHING TO MINT. The handle IS the code, so unlike a playlist or a
 * jam this link needs no round trip, never expires, and is the same string
 * every time - which is what makes it worth printing on something.
 *
 * The pictures are re-drawn through a canvas into data URLs before they go on
 * the card, because the card is rasterised by widget/shot.ts and a registry
 * URL would not draw inside the shot.
 */

/** A picture shrunk into a data URL - the only form the card's shot can carry.
 *  Null where it will not draw (a dead URL, an image the canvas may not read). */
function thumbnail(url: string, size: number, ratio = 1): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const w = size;
        const h = Math.round(size / ratio);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);
        // Cover: crop to the card's shape rather than squash to it.
        const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight);
        const dw = img.naturalWidth * scale;
        const dh = img.naturalHeight * scale;
        ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

/**
 * The card's ground when there is no banner: a gradient chosen by the handle.
 *
 * Seeded rather than fixed so two people's cards do not come out identical -
 * a share card is a picture of a PERSON, and the one thing it always knows
 * about them is their name. The same handle always lands on the same colours,
 * which is what makes it read as theirs rather than as decoration.
 *
 * Deep and low-chroma on purpose: white type and a white QR sit on this, and
 * the accent the app uses elsewhere is far too bright to put them on.
 */
function seededGround(handle: string): CSSProperties {
  let h = 0;
  for (let i = 0; i < handle.length; i += 1) h = (h * 31 + handle.charCodeAt(i)) % 360;
  // A second hue a step around the wheel, so the sweep has somewhere to go.
  const far = (h + 48) % 360;
  return {
    background: `linear-gradient(155deg, hsl(${h} 46% 30%) 0%, hsl(${far} 52% 12%) 100%)`,
  };
}

function ProfileCardFace({
  cardRef,
  handle,
  avatar,
  banner,
  link,
  qr,
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  handle: string;
  avatar: string | null;
  banner: string | null;
  link: string;
  qr: string | null;
}) {
  return (
    <div
      className="shareCard shareCard--profile"
      ref={cardRef}
      /* The seeded gradient rides on the card itself so it is the ground the
         whole card sits on rather than a panel laid over one. A banner, when
         there is one, covers it. */
      style={seededGround(handle)}
    >
      {/* The banner IS the card's background - not a picture inside a frame
          inside a card. An <img> rather than a CSS background-image because
          this DOM is rasterised for the saved picture and an absolutely
          positioned img is the form that reliably draws. */}
      {banner && <img className="shareProfile__bg" src={banner} alt="" aria-hidden />}
      {/* Type over a photograph needs a ground of its own. A vertical wash,
          dark at the foot where the link and the QR live, so a bright banner
          cannot swallow them - and no backdrop-filter, which has no backdrop
          inside the shot. */}
      <div className="shareProfile__veil" aria-hidden />
      <div className="shareCard__head">
        <img className="shareCard__logo" src={logo} alt="AttackFM" />
        <span className="shareCard__kicker">On AttackFM</span>
      </div>
      {/* Centred on the card's own picture, with nothing around it but a ring.
          It used to sit in a rounded square in the middle of the card, which
          is a card inside a card - two frames saying the same thing, and the
          inner one shrinking the picture to make room for itself. */}
      {avatar ? (
        <img className="shareProfile__face" src={avatar} alt="" />
      ) : (
        <span className="shareProfile__face shareProfile__face--bare" aria-hidden>
          <UserRound size={38} />
        </span>
      )}
      <p className="shareCard__name">@{handle}</p>
      <p className="shareCard__sub">Add me and we can listen along</p>
      <div className="shareCard__qrRow">
        {qr ? (
          <img className="shareCard__qr" src={qr} alt="Link as a QR code" />
        ) : (
          <span className="shareCard__qr" aria-hidden />
        )}
        <div className="shareCard__linkWrap">
          <span className="shareCard__linkLabel">Scan, or open</span>
          <span className="shareCard__link">{link.replace(/^https?:\/\//, '')}</span>
        </div>
      </div>
      <p className="shareCard__foot">attack.fm · your listening stays for friends</p>
    </div>
  );
}

export function ShareProfileSheet({
  handle,
  avatarUrl,
  bannerUrl,
  open,
  onClose,
}: {
  handle: string;
  avatarUrl: string | null;
  bannerUrl: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const link = profileLink(handle);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void Promise.all([
      avatarUrl ? thumbnail(avatarUrl, 320) : Promise.resolve(null),
      bannerUrl ? thumbnail(bannerUrl, 720, 21 / 9) : Promise.resolve(null),
    ]).then(([face, band]) => {
      if (!live) return;
      setAvatar(face);
      setBanner(band);
    });
    return () => {
      live = false;
    };
  }, [open, avatarUrl, bannerUrl]);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void QRCode.toDataURL(link, { margin: 1, width: 320, color: { dark: '#101014', light: '#ffffff' } })
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        // No QR is a card with a printed link on it, which still works.
      });
    return () => {
      live = false;
    };
  }, [open, link]);

  // Drawn ahead of the tap: iOS only opens a share sheet inside the gesture,
  // and an await between the two loses it.
  useEffect(() => {
    if (!open) return;
    setPng(null);
    const node = cardRef.current;
    if (!node) return;
    let live = true;
    const timer = window.setTimeout(() => {
      const box = node.getBoundingClientRect();
      void shoot(node, Math.round(box.width), Math.round(box.height), 4).then((url) => {
        if (live && url) setPng(url);
      });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, qr, avatar, banner]);

  const saveImage = async () => {
    const node = cardRef.current;
    if (!node || saving) return;
    setSaving(true);
    try {
      const box = node.getBoundingClientRect();
      const dataUrl = png ?? (await shoot(node, Math.round(box.width), Math.round(box.height), 4));
      if (!dataUrl) {
        toast({ message: 'Could not draw the card. Try again in a moment.' });
        return;
      }
      await saveCardImage({
        dataUrl,
        filename: `attackfm-${handle.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'profile'}.png`,
        title: `@${handle} on AttackFM`,
        say: (message) => toast({ message }),
      });
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ message: 'Could not copy - long-press the link on the card to select it.' });
    }
  };

  return (
    <GlassSheet open={open} onClose={onClose} label="Share your profile" className="shareSheet">
      <h2 className="shareSheet__title">Share your profile</h2>
      <div className="shareSheet__linkFace">
        <ProfileCardFace
          cardRef={cardRef}
          handle={handle}
          avatar={avatar}
          banner={banner}
          link={link}
          qr={qr}
        />
        <div className="shareSheet__actions">
          <Button variant="ghost" onClick={() => void copyLink()}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <Button variant="solid" onClick={() => void saveImage()} disabled={saving}>
            <Download size={16} />
            {saving ? 'Saving…' : 'Save image'}
          </Button>
        </div>
        {/* Said plainly, because "share my profile" is exactly the phrase that
            makes people wonder what they just published. */}
        <Text tone="muted" size="xs" className="shareSheet__hint">
          The link shows your handle and your pictures, and nothing else. What you listen to stays
          for friends - opening it in AttackFM offers to add you as one.
        </Text>
      </div>
    </GlassSheet>
  );
}
