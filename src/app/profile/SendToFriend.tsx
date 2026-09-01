import { Button, Drawer, Spinner, Text } from '@glacier/react';
import { Check, Send } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { FriendAvatar } from './RegistryFriends.tsx';
import { fetchFriends, sendShare, type RegistryFriend } from '../servers/registry.ts';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import type { Track } from '../core/tauri.ts';

/**
 * Send a song to a friend.
 *
 * What travels is the NAME - artist and title - through the registry, to
 * their inbox; their own hub then goes and gets the song the way it gets
 * anything (a pending like). No file leaves this server, none arrives on
 * theirs from here, and neither hub has to be able to reach the other -
 * which is what makes it work between two houses.
 *
 * The first song you send anyone waits until they say they take songs from
 * you at all, so that once the row says "Asked" rather than "Sent".
 */
export function SendToFriendDialog({
  track,
  open,
  onClose,
}: {
  track: Track;
  open: boolean;
  onClose: () => void;
}) {
  const registry = useRegistryOptional();
  const token = registry?.session?.token ?? null;
  const [friends, setFriends] = useState<RegistryFriend[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, 'sent' | 'asked'>>({});
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !token) return;
    let alive = true;
    setNote(null);
    setSent({});
    fetchFriends(token)
      .then((f) => {
        if (alive) setFriends(f.friends);
      })
      .catch(() => {
        if (alive) setFriends([]);
      });
    return () => {
      alive = false;
    };
  }, [open, token]);

  const send = async (friend: RegistryFriend) => {
    if (!token) return;
    setBusy(friend.handle);
    setNote(null);
    try {
      const { pending } = await sendShare(token, {
        handle: friend.handle,
        artist: track.artist,
        title: track.title,
        album: track.album,
      });
      setSent((prev) => ({ ...prev, [friend.handle]: pending ? 'asked' : 'sent' }));
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'That did not go through.');
    } finally {
      setBusy(null);
    }
  };

  const anyAsked = Object.values(sent).includes('asked');

  return (
    <Drawer open={open} onClose={onClose} side="bottom" size="lg" title="Send to a friend" className="sendToFriendSheet">
      <div className="sendToFriend">
        <Text tone="muted" size="sm">
          {track.title} · {track.artist}. They get the name; their own server fetches the song.
        </Text>
        {note && (
          <p className="friendsNote friendsNote--bad" role="status">
            {note}
          </p>
        )}
        {friends === null ? (
          <div className="sendToFriend__wait">
            <Spinner size="sm" aria-label="Loading friends" />
          </div>
        ) : friends.length === 0 ? (
          <Text tone="muted" size="sm">
            No friends yet - add some on the Friends page first.
          </Text>
        ) : (
          <ul className="sendToFriend__list">
            {friends.map((f) => {
              const state = sent[f.handle];
              return (
                <li key={f.id} className="sendToFriend__row">
                  <FriendAvatar handle={f.handle} size="md" />
                  <span className="sendToFriend__handle">{f.handle}</span>
                  <Button
                    variant={state ? 'outline' : 'solid'}
                    size="sm"
                    disabled={busy !== null || state !== undefined}
                    onClick={() => void send(f)}
                  >
                    {busy === f.handle ? <Spinner size="sm" aria-label="" /> : state ? <Check size={15} /> : <Send size={15} />}
                    <span>{state === 'sent' ? 'Sent' : state === 'asked' ? 'Asked' : 'Send'}</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        {anyAsked && (
          <Text tone="muted" size="xs">
            Asked: the first song from you waits until they say they take songs from you.
          </Text>
        )}
      </div>
    </Drawer>
  );
}
