import { Modal, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import { clearInvite, onInvite } from './deepLink.ts';
import { JoinServer } from './JoinServer.tsx';

/**
 * A tapped invite link opens Join, wherever you are.
 *
 * The only thing that consumed an invite was the Join screen itself, mounted
 * during first-run and behind Profile -> "Join another server". A verified
 * link into a running app on the Library tab therefore did nothing visible -
 * the code sat in the replay store forever. This mounts once, above the
 * pages, and raises Join the moment a code arrives; Join's own subscription
 * then fills the field. Closing spends the invite so it does not come back.
 */
export function InviteBridge() {
  const [open, setOpen] = useState(false);
  useEffect(() => onInvite(() => setOpen(true)), []);
  if (!open) return null;
  const close = () => {
    setOpen(false);
    clearInvite();
  };
  return (
    <Modal open onClose={close} title="Join a server" size="sm">
      <div className="friendsModal">
        <JoinServer />
        <Text size="sm" tone="muted">
          Someone sent you an invite. Joining adds their server to the ones you listen from.
        </Text>
      </div>
    </Modal>
  );
}
