import { Button, Drawer, Input, Modal, Switch, Text, Textarea, useToast } from '@glacier/react';
import { ListMusic, UserPlus, Users, X } from '@glacier/icons';
import { useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/LocaleShell.tsx';
import { useLibrary } from '../library/library.tsx';
import { useNarrowViewport } from '../ux/useNarrowViewport.ts';
import { openFriendPicker, sayNames, type PickedPerson } from '../nav/friendPickerDoor.ts';
import { clearNewPlaylist, onNewPlaylist, type NewPlaylistRequest } from '../nav/newPlaylistDoor.ts';
import { openPlaylistWith } from '../nav/playlistDoor.ts';
import { FriendAvatar } from '../profile/RegistryFriends.tsx';
import { usePlaylists } from './playlists.tsx';

/**
 * New playlist - the one sheet every "New playlist…" opens.
 *
 * A name, what it is for, and - on a server that can share - the switch
 * that makes it collaborative from the start: friends you choose here are
 * seated as editors the moment the list exists, and the page you land on
 * opens with them on its Members face. The old way was a name field in
 * three different places and a share sheet you had to go and find
 * afterwards; a shared list is a thing you MAKE, not a thing you do to a
 * list later.
 *
 * Hoisted to app level (App.tsx) and opened through nav/newPlaylistDoor,
 * because two of its seats are inside sheets and dialogs of their own -
 * the add-to-playlist drawer, the download chooser - and each of those
 * hands over what it knows (the songs to file, a name to suggest, what to
 * do with the id) and closes.
 */
export function NewPlaylistSheet() {
  const t = useT();
  const [request, setRequest] = useState<NewPlaylistRequest | null>(null);
  const [tick, setTick] = useState(0);
  const narrow = useNarrowViewport();
  useEffect(
    () =>
      onNewPlaylist((req) => {
        setRequest(req);
        // A fresh body per ask, even when one was already up.
        setTick((n) => n + 1);
      }),
    [],
  );
  const close = () => {
    setRequest(null);
    clearNewPlaylist();
  };
  const open = request !== null;
  const body = request ? <NewPlaylistBody key={tick} request={request} onClose={close} /> : null;

  if (narrow) {
    return (
      <Drawer open={open} onClose={close} side="bottom" size="lg" title={t('playlists.newTitle')} className="newPlaylistSheet">
        {body}
      </Drawer>
    );
  }
  return (
    <Modal open={open} onClose={close} title={t('playlists.newTitle')} size="sm">
      {body}
    </Modal>
  );
}

function NewPlaylistBody({ request, onClose }: { request: NewPlaylistRequest; onClose: () => void }) {
  const { create, setMeta, share, addWant } = usePlaylists();
  const { tracks } = useLibrary();
  const { toast } = useToast();
  const t = useT();
  const [name, setName] = useState('');
  const [about, setAbout] = useState('');
  const [together, setTogether] = useState(false);
  const [people, setPeople] = useState<PickedPerson[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | null>(null);

  // The kit's dialog takes focus as it opens; the name field takes it back
  // once the sheet has settled - it is the whole sheet on a phone.
  useEffect(() => {
    const timer = window.setTimeout(() => field.current?.focus(), 180);
    return () => window.clearTimeout(timer);
  }, []);

  const paths = request.paths ?? [];
  const want = request.want ?? null;
  // What the list is born holding, said once under the name.
  const first = paths.length > 0 ? tracks.find((t) => t.path === paths[0]) : null;
  // Three different sentences, not one with a variable in it: a wanted song
  // says something the other two do not, and "starts with N songs" counts.
  const holding = want
    ? t('playlists.startsWithWant', { title: want.title })
    : paths.length === 1
      ? t('playlists.startsWithOne', { title: first?.title ?? t('playlists.thisSong') })
      : paths.length > 1
        ? t('playlists.startsWithCount', { count: paths.length })
        : null;
  const seed = request.seed?.trim() || want?.title || first?.title || '';
  // Only a server that shares can seat anyone; a local library's switch
  // would be a promise with nobody to keep it.
  const canShare = !!share;

  const choose = async () => {
    const pick = await openFriendPicker({
      title: t('playlists.choosePeople'),
      hint: t('playlists.choosePeopleHint'),
      mode: 'playlist',
      exclude: people.map((p) => p.handle),
      action: (n) => (n ? t('playlists.chooseCount', { count: n }) : t('playlists.choose')),
    });
    if (!pick) return;
    setPeople((cur) => {
      const had = new Set(cur.map((p) => p.handle.toLowerCase()));
      return [...cur, ...pick.people.filter((p) => !had.has(p.handle.toLowerCase()))];
    });
  };

  const make = async () => {
    if (busy) return;
    const clean = name.trim() || seed || t('library.newPlaylist');
    setBusy(true);
    setError(null);
    try {
      const id = await create(clean, paths);
      if (want && addWant) await addWant(id, want);
      if (about.trim()) setMeta(id, { description: about.trim() });
      const seated: string[] = [];
      const refused: string[] = [];
      if (together && share) {
        for (const p of people) {
          try {
            await share(id, { username: p.handle }, 'editor');
            seated.push(p.handle);
          } catch (e) {
            // One sentence, not a handle glued to a reason with a colon: which
            // side of the message the name belongs on is a language's business.
            refused.push(
              t('playlists.seatRefusedFor', {
                who: p.handle,
                reason: e instanceof Error && e.message ? e.message : t('playlists.seatRefused'),
              }),
            );
          }
        }
      }
      toast({
        message: seated.length
          ? t('playlists.madeWith', { name: clean, who: sayNames(seated) })
          : t('playlists.made', { name: clean }),
      });
      for (const line of refused) toast({ message: line });
      onClose();
      request.onCreated?.(id, clean);
      // A list made WITH people lands on its page with them in view; a
      // seat that asked for the id does its own thing with it otherwise.
      if (seated.length > 0) openPlaylistWith(id, { members: true });
      else if (!request.onCreated) openPlaylistWith(id);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : t('playlists.makeFailed'));
      setBusy(false);
    }
  };

  return (
    <form
      className="newPlaylist"
      onSubmit={(e) => {
        e.preventDefault();
        void make();
      }}
    >
      <label className="newPlaylist__field">
        <span className="newPlaylist__label">{t('playlists.nameLabel')}</span>
        <Input
          ref={field}
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder={seed || t('playlists.namePrompt')}
          aria-label={t('playlists.nameField')}
          enterKeyHint="done"
          disabled={busy}
        />
      </label>
      {holding && (
        <Text tone="muted" size="xs" className="newPlaylist__holding">
          <ListMusic size={13} aria-hidden /> {holding}
        </Text>
      )}
      <label className="newPlaylist__field">
        <span className="newPlaylist__label">{t('playlists.aboutLabel')}</span>
        <Textarea
          value={about}
          onChange={(e) => setAbout(e.currentTarget.value)}
          placeholder={t('playlists.aboutPrompt')}
          aria-label={t('playlists.description')}
          rows={2}
          disabled={busy}
        />
      </label>

      {canShare && (
        <div className="newPlaylist__together" data-on={together || undefined}>
          <label className="newPlaylist__switch">
            <span className="newPlaylist__switchText">
              <span className="newPlaylist__switchTitle">
                <Users size={15} aria-hidden /> {t('playlists.collaborative')}
              </span>
              <span className="newPlaylist__switchSub">{t('playlists.collaborativeSub')}</span>
            </span>
            <Switch checked={together} onCheckedChange={setTogether} aria-label={t('playlists.collaborative')} disabled={busy} />
          </label>
          {together && (
            <>
              <button type="button" className="jamCard fpDoor" onClick={() => void choose()} disabled={busy}>
                <span className="fpDoor__glyph" aria-hidden>
                  <UserPlus size={16} />
                </span>
                <span className="fpDoor__text">
                  {/* Two labels for two states, not a plural: "more" is about
                      whether anyone is chosen yet, not about how many. */}
                  <span className="fpDoor__title">
                    {people.length ? t('playlists.chooseMorePeople') : t('playlists.choosePeople')}
                  </span>
                  <span className="fpDoor__sub">{t('playlists.choosePeopleWho')}</span>
                </span>
              </button>
              {people.length > 0 && (
                <div className="friendPicker__chips" role="list" aria-label={t('playlists.chosen')}>
                  {people.map((p) => (
                    <button
                      key={p.handle}
                      type="button"
                      role="listitem"
                      className="fpChip"
                      aria-label={t('playlists.removePerson', { name: p.handle })}
                      disabled={busy}
                      onClick={() => setPeople((cur) => cur.filter((x) => x.handle !== p.handle))}
                    >
                      <FriendAvatar handle={p.handle} size="sm" />
                      <span className="fpChip__name">{p.handle}</span>
                      <X size={14} aria-hidden />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {error && (
        <Text tone="danger" size="xs" role="status">
          {error}
        </Text>
      )}

      <div className="newPlaylist__actions">
        <Button variant="ghost" type="button" onClick={onClose} disabled={busy}>
          {t('common.notNow')}
        </Button>
        <Button variant="solid" type="submit" disabled={busy}>
          {busy ? t('playlists.making') : together && people.length ? t('playlists.createWith', { count: people.length }) : t('playlists.create')}
        </Button>
      </div>
    </form>
  );
}
