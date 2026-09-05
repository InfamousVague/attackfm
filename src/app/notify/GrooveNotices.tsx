import { useEffect } from 'react';
import { useJamOptional } from '../player/jam.tsx';
import { dismissNotice, msOf, noteNotice } from './notices.ts';

/**
 * An ask into a groove, in the bell.
 *
 * A friend inviting you to groove (or asking to listen along with you) used
 * to be a toast - three seconds over whatever you were doing, then gone - and
 * a card on the profile page, which is the page you are not on. This is the
 * same ask as a row you can come back to, with Accept as its door: pressing
 * the row answers it (the bell's 'groove' door calls the provider's own
 * accept), so nothing here fetches or decides anything.
 *
 * Reads the groove provider's poll rather than running one: the invites are
 * already on the room feed every device reads, and this only mirrors them.
 * One row per asker, keyed by name, so a re-ask replaces rather than stacks;
 * an ask answered anywhere (accepted, declined, expired) takes its row away.
 */

const raised = new Set<string>();

export function GrooveNotices() {
  const jam = useJamOptional();
  const invites = jam?.invites;

  useEffect(() => {
    const open = new Set<string>();
    for (const inv of invites ?? []) {
      const id = `groove:${inv.from.toLowerCase()}`;
      open.add(id);
      raised.add(id);
      noteNotice({
        id,
        kind: 'groove',
        title:
          inv.kind === 'jam'
            ? `${inv.from} invited you to groove`
            : `${inv.from} wants to listen along`,
        body:
          inv.kind === 'jam'
            ? 'Tap to join their groove.'
            : 'Tap to start a groove with your player as the clock.',
        art: null,
        door: 'groove',
        from: inv.from,
        at: msOf(inv.at),
      });
    }
    for (const id of [...raised]) {
      if (!open.has(id)) {
        dismissNotice(id);
        raised.delete(id);
      }
    }
  }, [invites]);

  return null;
}
