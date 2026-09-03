import { useCallback, useEffect, useState } from 'react';
import { Button, Input, Label, Pill, Spinner, Switch, Text } from '@glacier/react';
import { useServerSession } from '@attackfm/app/serverSession';
import {
  connectRemote,
  disconnectRemote,
  fetchDoor,
  fetchRemote,
  mintSecret,
  revokeSecret,
  setDoor,
  type DoorStatus,
  type RemoteStatus,
} from './api.ts';

/**
 * Two settings, and they point in opposite directions.
 *
 * The DOOR is the owner's: whether this library answers the Subsonic API at
 * all, so somebody's phone app can play from it. Off by default, because a
 * second way in is the owner's decision and nobody else's.
 *
 * The APP PASSWORD is each member's own. The protocol's usual sign-in is
 * md5(password + salt), which needs the password readable on the server -
 * and the account password here is an argon2 hash, deliberately unreadable.
 * So a client gets a separate, random secret, shown once and revocable, and
 * never the real password. That is also why it can be revoked without
 * touching the account.
 *
 * The REMOTE is the member's too: another OpenSubsonic server they have an
 * account on, for bringing music across. Its password is kept the way the
 * Spotify cookie is - written in, never read back out.
 */
export function SubsonicSettings() {
  const { session } = useServerSession();
  const [door, setDoorState] = useState<DoorStatus | null>(null);
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [d, r] = await Promise.all([fetchDoor(session), fetchRemote(session)]);
      setDoorState(d);
      setRemote(r);
    } catch {
      // A hub from before this existed answers 404; the pane says so below
      // rather than sitting blank forever.
      setDoorState(null);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!session) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          This is about your server: the one that would answer Subsonic apps, and the other server
          you might bring music from. Connect one under Settings &rarr; Server first.
        </Text>
      </div>
    );
  }

  const run = async (which: string, work: () => Promise<void>) => {
    setBusy(which);
    setNote(null);
    try {
      await work();
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'That did not go through.' });
    } finally {
      setBusy(null);
    }
  };

  const base = door?.url ?? session.url;

  return (
    <div className="prefsBody">
      {/* --- the door ------------------------------------------------------ */}
      <div className="prefsSection">
        <Label>Let other apps play this library</Label>
        <Text tone="muted" size="sm">
          Answers the OpenSubsonic API, so apps built for Navidrome, Airsonic or Subsonic - Symfonium,
          play:Sub, Amperfy, Feishin and the rest - can browse and play what is here. Off unless you
          switch it on.
        </Text>
        {door === null ? (
          <Text tone="muted" size="xs">
            This server is running a build from before the Subsonic door existed. Update it and this
            tab fills in.
          </Text>
        ) : (
          <>
            <div className="prefsActions">
              <Switch
                label={door.enabled ? 'Open' : 'Closed'}
                checked={door.enabled}
                disabled={!session.isAdmin || busy !== null}
                onCheckedChange={(on) =>
                  void run('door', async () => {
                    const next = await setDoor(session, on);
                    setDoorState({ ...door, enabled: next.enabled });
                  })
                }
              />
              {busy === 'door' && <Spinner size="sm" aria-label="" />}
            </div>
            {!session.isAdmin && (
              <Text tone="muted" size="xs">
                Only whoever owns the server can open or close it. Your own app password below works
                either way, once it is open.
              </Text>
            )}
          </>
        )}
      </div>

      {/* --- the app password --------------------------------------------- */}
      {door?.enabled && (
        <div className="prefsSection">
          <Label>Your app password</Label>
          <Text tone="muted" size="sm">
            Subsonic apps sign in with a password of their own, not your account one. Point the app at{' '}
            <strong>{base}</strong>, sign in as <strong>{door.username}</strong>, and paste this.
          </Text>
          {secret ? (
            <>
              <div className="prefsActions">
                <Input value={secret} readOnly aria-label="Your app password" />
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void navigator.clipboard?.writeText(secret).catch(() => {})}
                >
                  Copy
                </Button>
              </div>
              <Text tone="muted" size="xs">
                Written down now or not at all - it is never shown again. Make another any time; the
                old one stops working the moment you do.
              </Text>
            </>
          ) : (
            <div className="prefsActions">
              <Button
                variant="solid"
                size="sm"
                disabled={busy !== null}
                onClick={() =>
                  void run('mint', async () => {
                    const made = await mintSecret(session);
                    setSecret(made.secret);
                    setDoorState((d) => (d ? { ...d, hasSecret: true } : d));
                  })
                }
              >
                {busy === 'mint' ? 'Making…' : door.hasSecret ? 'Make a new one' : 'Make an app password'}
              </Button>
              {door.hasSecret && (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void run('revoke', async () => {
                      await revokeSecret(session);
                      setSecret(null);
                      setDoorState((d) => (d ? { ...d, hasSecret: false } : d));
                      setNote({ tone: 'ok', text: 'Revoked. Apps holding it will be turned away.' });
                    })
                  }
                >
                  Revoke
                </Button>
              )}
              {door.hasSecret && <Pill tone="success">One exists</Pill>}
            </div>
          )}
        </div>
      )}

      {/* --- the remote ---------------------------------------------------- */}
      <div className="prefsSection">
        <Label>Bring music from another server</Label>
        <Text tone="muted" size="sm">
          A Navidrome, Airsonic, Gonic or another AttackFM you have an account on. Its playlists,
          albums and starred songs can be brought over on the OpenSubsonic tab.
        </Text>
        {remote?.connected ? (
          <div className="prefsActions">
            <Pill tone="success">
              {remote.username} at {remote.url}
            </Pill>
            {remote.serverType && <Pill>{remote.serverType}</Pill>}
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() =>
                void run('disconnect', async () => {
                  await disconnectRemote(session);
                  setRemote({ connected: false });
                })
              }
            >
              Disconnect
            </Button>
          </div>
        ) : (
          <>
            <div className="prefsActions">
              <Input
                value={url}
                onChange={(e) => setUrl(e.currentTarget.value)}
                placeholder="https://music.example.com"
                aria-label="The other server's address"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
            </div>
            <div className="prefsActions">
              <Input
                value={user}
                onChange={(e) => setUser(e.currentTarget.value)}
                placeholder="username there"
                aria-label="Your username there"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
              />
              <Input
                type="password"
                value={pass}
                onChange={(e) => setPass(e.currentTarget.value)}
                placeholder="password there"
                aria-label="Your password there"
              />
              <Button
                variant="solid"
                size="sm"
                disabled={busy !== null || !url.trim() || !user.trim() || !pass}
                onClick={() =>
                  void run('connect', async () => {
                    const next = await connectRemote(session, { url: url.trim(), username: user.trim(), password: pass });
                    setRemote(next);
                    setPass('');
                    setNote({ tone: 'ok', text: `Connected to ${next.serverType ?? 'the server'}.` });
                  })
                }
              >
                {busy === 'connect' ? 'Checking…' : 'Connect'}
              </Button>
            </div>
            <Text tone="muted" size="xs">
              The server is asked to answer with these before anything is kept, so a typo is told
              apart from a server that is down. The password stays on your own hub and is never
              readable again.
            </Text>
          </>
        )}
      </div>

      {note && (
        <Text size="sm" tone={note.tone === 'ok' ? 'success' : 'danger'}>
          {note.text}
        </Text>
      )}
    </div>
  );
}
