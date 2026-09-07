import { Modal } from '@glacier/react';
import { useEffect, useState } from 'react';
import { clearInvite, onInvite } from './deepLink.ts';
import { JoinCard } from './JoinCard.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

/**
 * A tapped invite link raises the join card over whatever page is up: the
 * server's name and glance, whose it is, one Join. The code travelled in the
 * link, so there is nothing to type - that form (JoinServer) is for a code
 * read off a picture, and lives on the Profile page.
 */
export function InviteBridge() {
  const t = useT();
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => onInvite((c) => setCode(c)), []);
  if (!code) return null;
  const close = () => {
    setCode(null);
    clearInvite();
  };
  return (
    <Modal open onClose={close} title={t('servers.inviteKicker')} size="sm">
      {/* Auto: the link IS the decision. Signed in, the card joins as it
          opens; signed out, it joins the moment the account form is done. */}
      <JoinCard code={code} onDone={close} auto />
    </Modal>
  );
}
