import { Button, Modal, Text } from '@glacier/react';
import { Users } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { clearJamLink, onJamLink } from '../servers/deepLink.ts';
import type { JamShare } from '../servers/registry.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useJamOptional } from './jam.tsx';
import { hubHost, lookupGroove, sameHub, walkIn } from './grooveEntry.ts';

/**
 * A groove LINK, opened in the app.
 *
 * The link says where a room is; whether you get into it is the hub's answer,
 * not the link's, and this is where that gets found out. Three ways it can go,
 * and each of them says which one happened rather than failing the same way:
 *
 *  - You are on that server: Join walks straight in.
 *  - You are on a DIFFERENT server: the link names the one it lives on, and
 *    says plainly that a groove is a room on one server. Guessing - switching
 *    servers under someone because a link asked - is not this feature's to do.
 *  - The room has ended: nothing on the registry can know that (the row
 *    outlives the room by design), so the hub is what tells us, and the answer
 *    is a sentence rather than a dead button.
 *
 * A join that WORKS closes this: the arrival is said by the provider's landing
 * (the toast, the player, the deck), the same way every other door in lands.
 *
 * Raised over whatever page is up, the way a playlist link is. The typed
 * door (JoinGrooveSheet, "Have a code?") walks the same road: the lookup,
 * the same-server test and the join live in grooveEntry, shared by both.
 */
export function JamLinkBridge() {
  const [code, setCode] = useState<string | null>(null);
  const [share, setShare] = useState<JamShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { session } = useServerSession();
  const jam = useJamOptional();

  useEffect(
    () =>
      onJamLink((c) => {
        setCode(c);
        setShare(null);
        setError(null);
      }),
    [],
  );

  useEffect(() => {
    if (!code) return;
    let live = true;
    lookupGroove(code)
      .then((s) => {
        if (!live) return;
        if (s) setShare(s);
        // The registry knows no link by that name - a mistyped code, or one
        // it never minted. Said in words rather than the API's own.
        else setError('That groove is not one we know about. The link may have been mistyped.');
      })
      .catch(() => {
        if (live) setError('Could not look that up just now. Try again in a moment.');
      });
    return () => {
      live = false;
    };
  }, [code]);

  if (!code) return null;

  const close = () => {
    setCode(null);
    clearJamLink();
  };

  const here = !!session && !!share && sameHub(session.url, share.hubUrl);

  const join = async () => {
    if (!share || !jam || busy) return;
    setBusy(true);
    setError(null);
    try {
      const walked = await walkIn(jam, share.jamId);
      if (walked === 'joined') {
        // "You are in" is the LANDING now, not a line on this card: the
        // provider says where you are, lifts the player and opens the groove
        // deck on it (jam.tsx). The card's work is done the moment the hub
        // says yes, so it gets out of the way of what it started.
        close();
      } else {
        // The registry row outlives the room; this is the hub saying the room
        // is not there any more, which is the one answer only it can give.
        setError(
          walked === 'failed'
            ? 'Could not walk into that groove just now.'
            : 'That groove has ended. Ask whoever sent this to start another.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={close} title="Listen along" size="sm">
      <div className="sharedPlaylist">
        {error && (
          <Text tone="danger" size="sm">
            {error}
          </Text>
        )}
        {!share && !error && (
          <Text tone="muted" size="sm">
            Opening…
          </Text>
        )}
        {share && (
          <>
            <div className="sharedPlaylist__head">
              <div className="sharedPlaylist__who">
                <h3 className="sharedPlaylist__name">
                  <Users size={15} aria-hidden /> {share.by ? `@${share.by}'s groove` : 'A groove'}
                </h3>
                <Text tone="muted" size="sm">
                  {share.hubName ? `On ${share.hubName}` : 'On another AttackFM server'}
                </Text>
              </div>
            </div>

            {here ? (
              <Text tone="muted" size="xs">
                Joining follows along with whatever they are playing. Anyone in the room can add to
                the queue.
              </Text>
            ) : (
              /* Named by ADDRESS, so the sentence is actionable and cannot be
                 misread: hubs are called things like "AttackFM" by default,
                 and "this one is on AttackFM" reads as a statement about the
                 app rather than about which box the room is on. */
              <Text tone="muted" size="xs">
                A groove is a room on one server, and this one is on {hubHost(share.hubUrl)}. You
                would need to be signed in there to walk into it - ask @{share.by} for an invite.
              </Text>
            )}

            <div className="sharedPlaylist__actions">
              {!here ? (
                <Button variant="solid" size="sm" onClick={close}>
                  Done
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={close}>
                    Not now
                  </Button>
                  <Button variant="solid" size="sm" disabled={busy || !jam} onClick={() => void join()}>
                    {busy ? 'Joining…' : 'Join the groove'}
                  </Button>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
