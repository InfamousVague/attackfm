import { Button, Input, Spinner, Text } from '@glacier/react';
import { Camera, Check, QrCode, Radio, UserPlus, X } from '@glacier/icons';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { useServerSession } from './serverSession.tsx';
import { EmptyArt } from './EmptyArt.tsx';
import { useJam } from './jam.tsx';
import { QrScanner } from './QrScanner.tsx';
import { friendPayload, parseFriendPayload, sameServer } from './pairing.ts';
import {
  acceptFriendRequest,
  declineFriendRequest,
  fetchFriends,
  removeFriend,
  sendFriendRequest,
  type FriendsFeed,
} from './server.ts';

/**
 * Friends: who you know on this server, the asks waiting on you, and the ones
 * waiting on them. Adding is by the name they signed up with - a server knows
 * its own accounts, so there is nothing to search across.
 *
 * Every action re-reads the whole feed rather than patching state in place.
 * The lists are small, the request is tiny, and it means two people acting at
 * the same moment converge instead of drifting.
 */
export function FriendsPage() {
  const { session } = useServerSession();
  const jam = useJam();
  const [feed, setFeed] = useState<FriendsFeed | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  // The QR half: 'mine' shows your own code for someone else to scan, 'scan'
  // opens the camera at theirs. Only ever one at a time - the camera and a
  // full-size code cannot share the space, and doing both at once on one
  // phone would be pointing it at itself.
  const [qrMode, setQrMode] = useState<'none' | 'mine' | 'scan'>('none');
  const [myQr, setMyQr] = useState<string | null>(null);
  const [cameraDead, setCameraDead] = useState(false);

  const refresh = useCallback(async () => {
    if (!session) return;
    try {
      setFeed(await fetchFriends(session));
    } catch {
      // Unreachable right now; whatever is on screen stays.
    }
  }, [session]);

  useEffect(() => {
    void refresh();
    // Someone else's answer lands here without a reload, on a slow clock -
    // a friends list is not worth a socket.
    const timer = window.setInterval(() => void refresh(), 20_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // Every mutation shares one shape: run it, say what happened, re-read.
  const act = async (run: () => Promise<void>, ok?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await run();
      if (ok) setNote({ tone: 'ok', text: ok });
      await refresh();
    } catch (error) {
      setNote({ tone: 'bad', text: error instanceof Error ? error.message : 'That did not work.' });
    } finally {
      setBusy(false);
    }
  };

  // My own code, drawn once per session and kept. The payload is a name and
  // a server, so it never goes stale and there is nothing to refresh.
  useEffect(() => {
    if (qrMode !== 'mine' || myQr || !session) return;
    let alive = true;
    void QRCode.toDataURL(friendPayload(session.url, session.username), {
      width: 320,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => {
        if (alive) setMyQr(url);
      })
      .catch(() => {
        // No code to show; the typed name below still works.
      });
    return () => {
      alive = false;
    };
  }, [qrMode, myQr, session]);

  // A scan lands here. Everything is checked before it becomes a request:
  // ours, this server's, and not a QR for something else entirely.
  const onScan = (text: string) => {
    const parsed = parseFriendPayload(text);
    if (!parsed) {
      setNote({ tone: 'bad', text: 'That is not an AttackFM friend code.' });
      return;
    }
    if (!sameServer(parsed.url, session!.url)) {
      setNote({
        tone: 'bad',
        text: `${parsed.username} is on a different server, so you cannot be friends here yet.`,
      });
      setQrMode('none');
      return;
    }
    setQrMode('none');
    void act(async () => {
      const { friends } = await sendFriendRequest(session!, parsed.username);
      setNote({
        tone: 'ok',
        text: friends
          ? `You and ${parsed.username} are now friends.`
          : `Asked ${parsed.username}.`,
      });
    });
  };

  const add = (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted || busy) return;
    void act(async () => {
      const { friends } = await sendFriendRequest(session!, wanted);
      setName('');
      setNote({
        tone: 'ok',
        // They had already asked: the ask crossing theirs IS the answer.
        text: friends ? `You and ${wanted} are now friends.` : `Asked ${wanted}.`,
      });
    });
  };

  if (!session) {
    return (
      <div className="homePage friendsPage">
        <div className="emptyState emptyState--tall">
          <EmptyArt name="friends" />
          <p className="emptyState__text">
            Sign in to your server to add friends. Friends live on the server you both use.
          </p>
        </div>
      </div>
    );
  }

  const friends = feed?.friends ?? [];
  const incoming = feed?.incoming ?? [];
  const outgoing = feed?.outgoing ?? [];

  return (
    <div className="homePage friendsPage">
      {/* The room, at the top: what you are in, or what your friends have
          open. Listening together is the point of having friends here. */}
      <section className="jamStrip">
        {jam.current ? (
          <div className="jamCard jamCard--live">
            <span className="jamCard__pulse" aria-hidden />
            <span className="jamCard__body">
              <span className="jamCard__title">
                {jam.hosting ? 'Your jam' : `${jam.current.hostName}'s jam`}
              </span>
              <span className="jamCard__sub">
                {jam.current.memberCount === 1
                  ? 'Just you so far'
                  : `${jam.current.memberCount} listening`}
                {jam.hosting ? ' · you set the pace' : ' · following along'}
              </span>
            </span>
            <Button variant="ghost" size="sm" onClick={() => void jam.leave()}>
              Leave
            </Button>
          </div>
        ) : (
          <Button variant="soft" size="sm" onClick={() => void jam.start()}>
            <Radio size={15} />
            <span>Start a jam</span>
          </Button>
        )}
      </section>

      {jam.friendJams.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Jams happening now</h2>
          <ul className="friendList">
            {jam.friendJams.map((room) => (
              <li key={room.id} className="friendRow">
                <span className="friendRow__avatar" aria-hidden>
                  {room.hostName.slice(0, 1).toUpperCase()}
                </span>
                <span className="friendRow__name">
                  {room.hostName}
                  <span className="jamRow__count">
                    {room.memberCount === 1 ? ' · alone' : ` · ${room.memberCount} listening`}
                  </span>
                </span>
                <span className="friendRow__actions">
                  <Button variant="solid" size="sm" onClick={() => void jam.join(room.id)}>
                    Join
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <form className="friendsAdd" onSubmit={add}>
        <Input
          className="friendsAdd__field"
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="Add someone by username"
          aria-label="Add a friend by username"
        />
        <Button type="submit" variant="solid" size="sm" disabled={busy || name.trim() === ''}>
          {busy ? <Spinner size="sm" aria-label="" /> : <UserPlus size={15} />}
          <span>Add</span>
        </Button>
      </form>

      <div className="friendsQrBar">
        <Button
          variant={qrMode === 'mine' ? 'soft' : 'ghost'}
          size="sm"
          aria-pressed={qrMode === 'mine'}
          onClick={() => setQrMode((m) => (m === 'mine' ? 'none' : 'mine'))}
        >
          <QrCode size={15} />
          <span>My code</span>
        </Button>
        <Button
          variant={qrMode === 'scan' ? 'soft' : 'ghost'}
          size="sm"
          aria-pressed={qrMode === 'scan'}
          onClick={() => {
            setCameraDead(false);
            setQrMode((m) => (m === 'scan' ? 'none' : 'scan'));
          }}
        >
          <Camera size={15} />
          <span>Scan a code</span>
        </Button>
      </div>

      {qrMode === 'mine' && (
        <section className="friendsQr">
          {myQr ? (
            <img className="friendsQr__img" src={myQr} alt="Your friend code" />
          ) : (
            <div className="friendsQr__img friendsQr__img--waiting">
              <Spinner size="md" aria-label="Drawing your code" />
            </div>
          )}
          <Text tone="muted" size="sm">
            Have them scan this. You are <strong>{session.username}</strong>.
          </Text>
        </section>
      )}

      {qrMode === 'scan' && (
        <section className="friendsQr">
          {cameraDead ? (
            <Text tone="muted" size="sm">
              No camera here. Type their username above instead.
            </Text>
          ) : (
            <div className="friendsQr__cam">
              <QrScanner onResult={onScan} onUnavailable={() => setCameraDead(true)} />
            </div>
          )}
        </section>
      )}

      {note && (
        <p className={`friendsNote friendsNote--${note.tone}`} role="status">
          {note.text}
        </p>
      )}

      {incoming.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Wants to be friends</h2>
          <ul className="friendList">
            {incoming.map((r) => (
              <li key={r.id} className="friendRow">
                <span className="friendRow__avatar" aria-hidden>
                  {r.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="friendRow__name">{r.username}</span>
                <span className="friendRow__actions">
                  <Button
                    variant="solid"
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(() => acceptFriendRequest(session, r.id))}
                  >
                    <Check size={15} />
                    <span>Accept</span>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Decline ${r.username}`}
                    onClick={() => void act(() => declineFriendRequest(session, r.id))}
                  >
                    <X size={15} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {outgoing.length > 0 && (
        <section className="homeShelf">
          <h2 className="homeShelfTitle">Asked</h2>
          <ul className="friendList">
            {outgoing.map((r) => (
              <li key={r.id} className="friendRow">
                <span className="friendRow__avatar" aria-hidden>
                  {r.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="friendRow__name">{r.username}</span>
                <span className="friendRow__actions">
                  <Text tone="muted" size="sm">
                    Waiting
                  </Text>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    aria-label={`Withdraw the ask to ${r.username}`}
                    onClick={() => void act(() => declineFriendRequest(session, r.id))}
                  >
                    <X size={15} />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="homeShelf">
        <h2 className="homeShelfTitle">
          Friends{friends.length > 0 ? ` · ${friends.length}` : ''}
        </h2>
        {friends.length === 0 ? (
          <div className="emptyState">
            <EmptyArt name="friends" />
            <p className="emptyState__text">
              Nobody yet. Add someone by the username they signed in with, and they will show up
              here once they say yes.
            </p>
          </div>
        ) : (
          <ul className="friendList">
            {friends.map((f) => (
              <li key={f.userId} className="friendRow">
                <span className="friendRow__avatar" aria-hidden>
                  {f.username.slice(0, 1).toUpperCase()}
                </span>
                <span className="friendRow__name">{f.username}</span>
                <span className="friendRow__actions">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => void act(() => removeFriend(session, f.userId))}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
