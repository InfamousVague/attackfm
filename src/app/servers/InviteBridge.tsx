import { Modal } from '@glacier/react';
import { useEffect, useState } from 'react';
import { clearInvite, onInvite } from './deepLink.ts';
import { JoinCard } from './JoinCard.tsx';

/**
 * A tapped invite link raises the join card over whatever page is up: the
 * server's name and glance, whose it is, one Join. The code travelled in the
 * link, so there is nothing to type - that form (JoinServer) is for a code
 * read off a picture, and lives on the Profile page.
 */
export function InviteBridge() {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => onInvite((c) => setCode(c)), []);
  if (!code) return null;
  const close = () => {
    setCode(null);
    clearInvite();
  };
  return (
    <Modal open onClose={close} title="You're invited" size="sm">
      <JoinCard code={code} onDone={close} />
    </Modal>
  );
}
