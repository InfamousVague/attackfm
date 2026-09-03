import { Button, Modal, Text } from '@glacier/react';
import { Users } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { clearJamLink, onJamLink } from '../servers/deepLink.ts';
import { fetchJamShare, type JamShare } from '../servers/registry.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import { useJamOptional } from './jam.tsx';

/**
 * A jam LINK, opened in the app.
 *
 * The link says where a room is; whether you get into it is the hub's answer,
 * not the link's, and this is where that gets found out. Three ways it can go,
 * and each of them says which one happened rather than failing the same way:
 *
 *  - You are on that server: Join walks straight in.
 *  - You are on a DIFFERENT server: the link names the one it lives on, and
 *    says plainly that a jam is a room on one server. Guessing - switching
 *    servers under someone because a link asked - is not this feature's to do.
 *  - The room has ended: nothing on the registry can know that (the row
 *    outlives the room by design), so the hub is what tells us, and the answer
 *    is a sentence rather than a dead button.
 *
 * Raised over whatever page is up, the way a playlist link is.
 */
export function JamLinkBridge() {
  const [code, setCode] = useState<string | null>(null);
  const [share, setShare] = useState<JamShare | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const { session } = useServerSession();
  const jam = useJamOptional();

  useEffect(
    () =>
      onJamLink((c) => {
        setCode(c);
        setShare(null);
        setError(null);
        setDone(false);
      }),
    [],
  );

  useEffect(() => {
    if (!code) return;
    let live = true;
    fetchJamShare(code)
      .then((s) => {
        if (live) setShare(s);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : 'Could not open that jam.');
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

  // Same box, ignoring the trailing slash and the scheme a link might carry
  // differently from the one the app signed in with.
  const same = (a: string, b: string) => {
    const bare = (u: string) => u.trim().replace(/\/+$/, '').replace(/^https?:\/\//, '').toLowerCase();
    return bare(a) === bare(b);
  };
  const here = !!session && !!share && same(session.url, share.hubUrl);

  const join = async () => {
    if (!share || !jam || busy) return;
    setBusy(true);
    setError(null);
    try {
      const ok = await jam.join(share.jamId);
      if (ok) {
        setDone(true);
      } else {
        // The registry row outlives the room; this is the hub saying the room
        // is not there any more, which is the one answer only it can give.
        setError('That jam has ended. Ask whoever sent this to start another.');
      }
    } catch {
      setError('Could not walk into that jam just now.');
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
                  <Users size={15} aria-hidden /> {share.by ? `@${share.by}'s jam` : 'A jam'}
                </h3>
                <Text tone="muted" size="sm">
                  {share.hubName ? `On ${share.hubName}` : 'On another AttackFM server'}
                </Text>
              </div>
            </div>

            {done ? (
              <Text size="sm">You are in. Same song, same moment.</Text>
            ) : here ? (
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
                A jam is a room on one server, and this one is on{' '}
                {share.hubUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '')}. You would need to
                be signed in there to walk into it - ask @{share.by} for an invite.
              </Text>
            )}

            <div className="sharedPlaylist__actions">
              {done || !here ? (
                <Button variant="solid" size="sm" onClick={close}>
                  Done
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={close}>
                    Not now
                  </Button>
                  <Button variant="solid" size="sm" disabled={busy || !jam} onClick={() => void join()}>
                    {busy ? 'Joining…' : 'Join the jam'}
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
