import { Button, Modal, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import { clearProfileLink, onProfileLink } from '../servers/deepLink.ts';
import { fetchProfileCard, sendFriendRequest, type ProfileCard } from '../servers/registry.ts';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { FriendAvatar } from './RegistryFriends.tsx';
import { Trans, useT } from '../i18n/LocaleShell.tsx';

/**
 * A profile LINK, opened in the app: a person, and the one thing you can do
 * about them.
 *
 * The registry gives this page the handle and the pictures and nothing else -
 * a profile is friends-only, which is what makes the link safe to hand out in
 * the first place. So the modal is an introduction: this is who, do you want
 * to ask. Asking is `sendFriendRequest`, the same act as typing the handle
 * into Friends, and if they had already asked YOU the registry makes you
 * friends on the spot and says so.
 *
 * Signed out, it still shows who: a link that answers "sign in first" without
 * saying who it was about is a link that wasted the tap.
 */
export function ProfileLinkBridge() {
  const t = useT();
  const [handle, setHandle] = useState<string | null>(null);
  const [card, setCard] = useState<ProfileCard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  const registry = useRegistryOptional();
  const token = registry?.session?.token ?? null;
  const me = registry?.session?.account.handle ?? null;

  useEffect(
    () =>
      onProfileLink((h) => {
        setHandle(h);
        setCard(null);
        setError(null);
        setSaid(null);
      }),
    [],
  );

  useEffect(() => {
    if (!handle) return;
    let live = true;
    fetchProfileCard(handle)
      .then((c) => {
        if (live) setCard(c);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : t('profile.linkOpenFailed'));
      });
    return () => {
      live = false;
    };
  }, [handle, t]);

  if (!handle) return null;

  const close = () => {
    setHandle(null);
    clearProfileLink();
  };

  const shown = card?.handle ?? handle;
  const itsMe = !!me && me.toLowerCase() === shown.toLowerCase();

  const ask = async () => {
    if (!token || busy) return;
    setBusy(true);
    setError(null);
    try {
      const out = await sendFriendRequest(token, shown);
      // The registry answers differently depending on whether they had already
      // asked; it writes the sentence, and it is the honest one either way.
      setSaid(
        out.message ||
          (out.friends ? t('profile.linkFriendsNow', { handle: shown }) : t('profile.linkAsked')),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t('profile.linkAskFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={close} title={t('profile.linkTitle')} size="sm">
      <div className="sharedPlaylist">
        {error && (
          <Text tone="danger" size="sm">
            {error}
          </Text>
        )}
        <div className="sharedPlaylist__head">
          <FriendAvatar handle={shown} size="lg" src={card?.avatarUrl ?? null} />
          <div className="sharedPlaylist__who">
            <h3 className="sharedPlaylist__name">@{shown}</h3>
            <Text tone="muted" size="sm">
              {itsMe ? t('profile.linkItsYou') : t('profile.linkAddThem')}
            </Text>
          </div>
        </div>

        {said ? (
          <Text size="sm">{said}</Text>
        ) : itsMe ? (
          <Text tone="muted" size="xs">
            {t('profile.linkYourOwn')}
          </Text>
        ) : !token ? (
          <Text tone="muted" size="xs">
            {t('profile.linkSignInFirst')}
          </Text>
        ) : (
          <Text tone="muted" size="xs">
            {/* The handle sits mid-sentence, so the sentence is one entry with
                the hole named inside it rather than two fragments around it. */}
            <Trans i18nKey="profile.linkAskExplains" values={{ handle: shown }} />
          </Text>
        )}

        <div className="sharedPlaylist__actions">
          {said || itsMe || !token ? (
            <Button variant="solid" size="sm" onClick={close}>
              {t('common.done')}
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={close}>
                {t('profile.linkNotNow')}
              </Button>
              <Button variant="solid" size="sm" disabled={busy} onClick={() => void ask()}>
                {busy ? t('profile.linkAsking') : t('profile.linkAdd', { handle: shown })}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
