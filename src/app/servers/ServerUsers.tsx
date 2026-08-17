import {
  AlertDialog,
  Avatar,
  Banner,
  Button,
  Field,
  Input,
  Label,
  Pill,
  Text,
} from '@glacier/react';
import { KeyRound, Trash2, UserPlus } from '@glacier/icons';
import { useCallback, useEffect, useState } from 'react';
import {
  deleteUser,
  fetchUsers,
  register,
  revokeUserStreams,
  type ServerUser,
} from '../server.ts';
import { useServerSession } from './serverSession.tsx';

/**
 * Account management, owner only - the client half of `/api/users`, which
 * until now existed with no UI at all.
 *
 * Three verbs, matching the server exactly: add a listener (registration is
 * admin-only past the first account), sign a listener's devices out
 * everywhere (revoke), and delete the account. Deletion confirms through an
 * AlertDialog because it is the one irreversible thing on this pane.
 */
export function UsersSection() {
  const { session } = useServerSession();
  const [users, setUsers] = useState<ServerUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The add-a-listener drawer.
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  // The account a delete is pending on; the dialog is the second look.
  const [condemned, setCondemned] = useState<ServerUser | null>(null);

  const refresh = useCallback(() => {
    if (!session) return;
    fetchUsers(session)
      .then((list) => {
        setUsers(list);
        setError(null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load accounts'));
  }, [session]);
  useEffect(() => refresh(), [refresh]);

  if (!session) return null;

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await register(session.url, newName.trim(), newPassword, session.token);
      setNotice(`Added ${newName.trim()}.`);
      setAdding(false);
      setNewName('');
      setNewPassword('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the account');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (user: ServerUser) => {
    setError(null);
    try {
      await revokeUserStreams(session, user.id);
      setNotice(`${user.username}'s devices were signed out everywhere.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not revoke');
    }
  };

  const remove = async (user: ServerUser) => {
    setCondemned(null);
    setError(null);
    try {
      await deleteUser(session, user.id);
      setNotice(`Deleted ${user.username}.`);
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the account');
    }
  };

  return (
    <div className="prefsSection">
      <Label>Accounts</Label>
      <Text tone="muted" size="sm">
        Everyone with a sign-in on this server. Listeners share the library and keep
        their own favourites, playlists, and history.
      </Text>

      {users === null && !error ? (
        <Text tone="muted" size="sm">
          Loading accounts…
        </Text>
      ) : (
        <div className="userRows">
          {(users ?? []).map((u) => (
            <div key={u.id} className="userRow">
              <Avatar name={u.username} size="sm" />
              <span className="userRow__name">
                <Text size="sm" weight="medium">
                  {u.username}
                  {u.username === session.username ? ' (you)' : ''}
                </Text>
                {u.isAdmin && (
                  <Pill size="sm" tone="accent">
                    Owner
                  </Pill>
                )}
              </span>
              <span className="userRow__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  title="Sign this account's devices out everywhere"
                  onClick={() => void revoke(u)}
                >
                  <KeyRound size={14} /> Revoke
                </Button>
                {u.username !== session.username && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title="Delete this account"
                    onClick={() => setCondemned(u)}
                  >
                    <Trash2 size={14} /> Delete
                  </Button>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {error && <Banner tone="danger">{error}</Banner>}
      {notice && !error && (
        <Banner tone="success" onDismiss={() => setNotice(null)}>
          {notice}
        </Banner>
      )}

      {adding ? (
        <div className="userAdd">
          <Field label="Username">
            <Input
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              aria-label="New username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Field label="Password" hint="At least 8 characters. They can change nothing about the server - just listen.">
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.currentTarget.value)}
              aria-label="New password"
              autoComplete="new-password"
            />
          </Field>
          <div className="prefsActions">
            <Button
              variant="solid"
              size="sm"
              disabled={busy || newName.trim().length === 0 || newPassword.length < 8}
              onClick={() => void add()}
            >
              {busy ? 'Adding…' : 'Add listener'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="prefsActions">
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <UserPlus size={14} /> Add listener…
          </Button>
        </div>
      )}

      <AlertDialog
        open={condemned !== null}
        onClose={() => setCondemned(null)}
        tone="danger"
        title={`Delete ${condemned?.username ?? ''}?`}
        description="Their favourites, playlists, and listening history go with the account. The music stays - the library belongs to the server."
        actionLabel="Delete account"
        cancelLabel="Keep it"
        onAction={() => {
          if (condemned) void remove(condemned);
        }}
      />
    </div>
  );
}
