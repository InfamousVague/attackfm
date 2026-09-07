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
import { useT } from '../i18n/LocaleShell.tsx';
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
  const t = useT();
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
      // The server's own message when there is one - it says WHICH thing went
      // wrong and is already in the reader's hands; ours is only the fallback.
      .catch((err) => setError(err instanceof Error ? err.message : t('servers.usersLoadFailed')));
  }, [session, t]);
  useEffect(() => refresh(), [refresh]);

  if (!session) return null;

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await register(session.url, newName.trim(), newPassword, session.token);
      setNotice(t('servers.userAdded', { name: newName.trim() }));
      setAdding(false);
      setNewName('');
      setNewPassword('');
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('servers.userAddFailed'));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (user: ServerUser) => {
    setError(null);
    try {
      await revokeUserStreams(session, user.id);
      setNotice(t('servers.userRevoked', { name: user.username }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('servers.userRevokeFailed'));
    }
  };

  const remove = async (user: ServerUser) => {
    setCondemned(null);
    setError(null);
    try {
      await deleteUser(session, user.id);
      setNotice(t('servers.userDeleted', { name: user.username }));
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('servers.userDeleteFailed'));
    }
  };

  return (
    <div className="prefsSection">
      <Label>{t('servers.accounts')}</Label>
      <Text tone="muted" size="sm">
        {t('servers.accountsBlurb')}
      </Text>

      {users === null && !error ? (
        <Text tone="muted" size="sm">
          {t('servers.accountsLoading')}
        </Text>
      ) : (
        <div className="userRows">
          {(users ?? []).map((u) => (
            <div key={u.id} className="userRow">
              <Avatar name={u.username} size="sm" />
              <span className="userRow__name">
                <Text size="sm" weight="medium">
                  {/* One name, marked when it is the reader's own - the whole
                      label is a single entry so a language that marks it with
                      something other than a trailing parenthetical can. */}
                  {u.username === session.username
                    ? t('servers.accountNameYou', { name: u.username })
                    : u.username}
                </Text>
                {u.isAdmin && (
                  <Pill size="sm" tone="accent">
                    {t('servers.accountOwner')}
                  </Pill>
                )}
              </span>
              <span className="userRow__actions">
                <Button
                  variant="ghost"
                  size="sm"
                  title={t('servers.accountRevokeTitle')}
                  onClick={() => void revoke(u)}
                >
                  <KeyRound size={14} /> {t('servers.accountRevoke')}
                </Button>
                {u.username !== session.username && (
                  <Button
                    variant="ghost"
                    size="sm"
                    title={t('servers.accountDeleteTitle')}
                    onClick={() => setCondemned(u)}
                  >
                    <Trash2 size={14} /> {t('common.delete')}
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
          <Field label={t('servers.accountUsername')}>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.currentTarget.value)}
              aria-label={t('servers.accountNewUsername')}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          </Field>
          <Field
            label={t('servers.accountPassword')}
            hint={t('servers.accountPasswordHint')}
          >
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.currentTarget.value)}
              aria-label={t('servers.accountNewPassword')}
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
              {busy ? t('servers.accountAdding') : t('servers.accountAdd')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="prefsActions">
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            <UserPlus size={14} /> {t('servers.accountAddOpen')}
          </Button>
        </div>
      )}

      <AlertDialog
        open={condemned !== null}
        onClose={() => setCondemned(null)}
        tone="danger"
        title={t('servers.accountDeleteConfirm', { name: condemned?.username ?? '' })}
        description={t('servers.accountDeleteConfirmBody')}
        actionLabel={t('servers.accountDeleteAction')}
        cancelLabel={t('servers.accountDeleteCancel')}
        onAction={() => {
          if (condemned) void remove(condemned);
        }}
      />
    </div>
  );
}
