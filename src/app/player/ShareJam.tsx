import { Button, Text, useToast } from '@glacier/react';
import { Check, Copy, Download, Users } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { GlassSheet } from '../ux/GlassSheet.tsx';
import { hostOf, jamQrDataUrl } from './jamShare.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { publishJamShare } from '../servers/registry.ts';
import { shoot } from '../widget/shot.ts';
import { saveCardImage } from '../widget/saveCard.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import logo from '../../assets/attack-white.png';

/**
 * "Share this groove" - the room as a link, on the same card a playlist and an
 * invite wear.
 *
 * The panel already printed the room's code, and copying it is a real thing
 * people do - but a code is only useful to somebody who already has the app
 * open on the right server and knows where to type it. A link is useful to
 * anybody: it lands on a page that says whose room it is, and offers the app.
 *
 * WHAT THE LINK DOES NOT CARRY is as deliberate as what it does. Not the song:
 * a groove moves song to song, and a card describing one moment would be lying by
 * the time anybody opened it. Not a guest pass either - the link says where the
 * room is, and the hub decides who gets in, exactly as it does for the typed
 * code. Somebody who is not on that server gets a page that tells them so
 * rather than a door that opens onto nothing.
 *
 * The card IS the picture: widget/shot.ts rasterises this DOM, which is why
 * everything on it sits on solid paint (a backdrop-filter has no backdrop
 * inside the shot) and why there is no artwork on it - a room has none. The
 * `Users` glyph is the mark this feature wears everywhere else, so the card
 * and the badge in the transport row are recognisably the same thing.
 */
function JamCard({
  cardRef,
  host,
  where,
  link,
  qr,
  listening,
}: {
  cardRef: React.RefObject<HTMLDivElement | null>;
  host: string;
  where: string;
  link: string | null;
  qr: string | null;
  listening: number;
}) {
  const t = useT();
  return (
    <div className="shareCard" ref={cardRef}>
      <div className="shareCard__head">
        {/* The product's name, which is the same word in every language -
            the invite card leaves its own logo's alt English for the same
            reason. */}
        <img className="shareCard__logo" src={logo} alt="AttackFM" />
        <span className="shareCard__kicker">{t('player.jamCardKicker')}</span>
      </div>
      {/* A room has no cover, and inventing one from whatever happens to be
          playing would put a record on the card that the room has already
          moved past. The mark instead. */}
      <div className="shareCard__art" data-n={0}>
        <span className="shareCard__artEmpty" aria-hidden>
          <Users size={40} />
        </span>
      </div>
      <p className="shareCard__name">
        {host ? t('player.hostGroove', { host }) : t('player.aGroove')}
      </p>
      {/* The one-listener case is not "1 listening" - it is the room before
          anyone else has arrived, which is a different sentence rather than a
          different number, so it is the `_one` form of the count and not a
          branch here. The server, when there is one, wraps that phrase rather
          than trailing it, so a language that puts the place first can. */}
      <p className="shareCard__sub">
        {where
          ? t('player.jamListenersWhere', {
              listeners: t('player.jamListeners', { count: listening }),
              where,
            })
          : t('player.jamListeners', { count: listening })}
      </p>
      <div className="shareCard__qrRow">
        {qr ? (
          <img className="shareCard__qr" src={qr} alt={t('player.jamQrAlt')} />
        ) : (
          <span className="shareCard__qr" aria-hidden />
        )}
        <div className="shareCard__linkWrap">
          <span className="shareCard__linkLabel">{t('player.jamScanOrOpen')}</span>
          <span className="shareCard__link">
            {link ? link.replace(/^https?:\/\//, '') : t('player.jamMakingLink')}
          </span>
        </div>
      </div>
      <p className="shareCard__foot">{t('player.jamCardFoot')}</p>
    </div>
  );
}

export function ShareJamSheet({
  jamId,
  hostName,
  listening,
  open,
  onClose,
}: {
  jamId: string;
  hostName: string;
  listening: number;
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { session } = useServerSession();
  const registry = useRegistryOptional();
  const { toast } = useToast();
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [png, setPng] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);

  const token = registry?.session?.token ?? null;
  // The address as people say it. A hub has no display name a session carries,
  // and the host is what a friend recognises anyway - it is the thing they
  // typed to get here.
  const where = session ? hostOf(session.url) : '';

  // The link is minted on open, and the registry hands back the SAME code for
  // a room this account has already shared - so re-opening the sheet during
  // one groove does not scatter a second link that means the same thing.
  useEffect(() => {
    if (!open) return;
    setLinkError(null);
    if (!token || !session || !jamId) return;
    let live = true;
    void publishJamShare(token, { jamId, hubUrl: session.url, hubName: where })
      .then((out) => {
        if (live) setLink(out.url);
      })
      .catch(() => {
        if (live) setLinkError(t('player.jamLinkFailed'));
      });
    return () => {
      live = false;
    };
    // `t` is deliberately not a dependency: it changes identity when the
    // language does, and re-minting the link because somebody switched to
    // German would be a network call for a string.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `t` is deliberately not a dependency: it changes identity when the language does, and re-minting the link because somebody switched to German…
  }, [open, token, session, jamId, where]);

  useEffect(() => {
    if (!link) {
      setQr(null);
      return;
    }
    let live = true;
    void jamQrDataUrl(link, 320)
      .then((url) => {
        if (live) setQr(url);
      })
      .catch(() => {
        // No QR is a card with a printed link on it, which still works.
      });
    return () => {
      live = false;
    };
  }, [link]);

  // Drawn ahead of the tap, because the share sheet on iOS has to be asked for
  // inside the gesture and an await between the two loses it.
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
  }, [open, link, qr]);

  const saveImage = async () => {
    const node = cardRef.current;
    if (!node || saving) return;
    setSaving(true);
    try {
      const box = node.getBoundingClientRect();
      const dataUrl = png ?? (await shoot(node, Math.round(box.width), Math.round(box.height), 4));
      if (!dataUrl) {
        toast({ message: t('player.jamCardShotFailed') });
        return;
      }
      await saveCardImage({
        dataUrl,
        filename: 'attackfm-groove.png',
        title: t('player.jamShareTitle', {
          name: hostName ? t('player.hostGroove', { host: hostName }) : t('player.aGroove'),
        }),
        say: (message) => toast({ message }),
      });
    } finally {
      setSaving(false);
    }
  };

  const copyLink = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast({ message: t('player.jamCopyFailed') });
    }
  };

  return (
    <GlassSheet open={open} onClose={onClose} label={t('player.shareGroove')} className="shareSheet">
      <h2 className="shareSheet__title">{t('player.shareThisGroove')}</h2>
      <div className="shareSheet__linkFace">
        <JamCard
          cardRef={cardRef}
          host={hostName}
          where={where}
          link={link}
          qr={qr}
          listening={listening}
        />
        {!token ? (
          <Text tone="muted" size="sm" className="shareSheet__note">
            {t('player.jamShareNeedsAccount')}
          </Text>
        ) : linkError ? (
          <Text tone="danger" size="sm" className="shareSheet__note">
            {linkError}
          </Text>
        ) : null}
        <div className="shareSheet__actions">
          <Button variant="ghost" onClick={() => void copyLink()} disabled={!link}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? t('player.jamCopied') : t('player.jamCopyLink')}
          </Button>
          <Button variant="solid" onClick={() => void saveImage()} disabled={saving || !link}>
            <Download size={16} />
            {saving ? t('player.jamSaving') : t('player.jamSaveImage')}
          </Button>
        </div>
        {/* The honest limit, said before the link is sent rather than
            discovered by whoever follows it. */}
        <Text tone="muted" size="xs" className="shareSheet__hint">
          {t('player.jamShareLimit')}
        </Text>
      </div>
    </GlassSheet>
  );
}
