import { Button, Modal, Text } from '@glacier/react';
import { Check, ListMusic } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { clearPlaylistLink, onPlaylistLink } from '../servers/deepLink.ts';
import { fetchPlaylistShare, type SharedPlaylist } from '../servers/registry.ts';
import { useT, useSongCount } from '../i18n/LocaleShell.tsx';
import { useOwned } from '../library/owned.ts';
import { usePlaylists } from './playlists.tsx';

/**
 * A playlist LINK, opened in the app.
 *
 * The link (registry.attack.fm/p/<code>) carries the playlist by name -
 * artist and title per song, a few small covers - because that is the only
 * form a playlist can take between two hubs that cannot see each other. This
 * is the far end: read it, hold it against what THIS library owns, and on
 * "Add" file it onto this hub as a playlist of its own - the songs already
 * here go straight in, the rest become wants the hub goes and fetches, and
 * the list fills in as they land. The songs were "reported to the hub", in
 * the plain sense: the hub now knows about them and gets them.
 *
 * Raised on top of whatever page is up, the way an invite link is.
 */
export function SharedPlaylistBridge() {
  const [code, setCode] = useState<string | null>(null);
  const [share, setShare] = useState<SharedPlaylist | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const t = useT();
  const songCount = useSongCount();
  const owned = useOwned();
  const { create, addWant } = usePlaylists();

  useEffect(
    () =>
      onPlaylistLink((c) => {
        setCode(c);
        setShare(null);
        setError(null);
        setDone(null);
      }),
    [],
  );

  useEffect(() => {
    if (!code) return;
    let live = true;
    fetchPlaylistShare(code)
      .then((s) => {
        if (live) setShare(s);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : t('playlists.shareOpenFailed'));
      });
    return () => {
      live = false;
    };
  }, [code, t]);

  // Each song, and the copy of it this library holds, if any.
  const rows = useMemo(
    () => (share ? share.tracks.map((t) => ({ t, have: owned.find(t.artist, t.title) })) : []),
    [share, owned],
  );
  const haveCount = rows.filter((r) => r.have).length;

  if (!code) return null;

  const close = () => {
    setCode(null);
    clearPlaylistLink();
  };

  const add = async () => {
    if (!share || busy) return;
    setBusy(true);
    setError(null);
    try {
      const paths = rows.filter((r) => r.have).map((r) => r.have!.path);
      const id = await create(share.name, paths);
      let wanted = 0;
      if (addWant) {
        for (const r of rows) {
          if (r.have) continue;
          await addWant(id, { artist: r.t.artist, title: r.t.title });
          wanted += 1;
        }
      }
      const missing = rows.length - paths.length - wanted;
      // Four independent clauses rather than one sentence with three holes:
      // each is optional, so a single catalogue entry would have to carry every
      // combination of them. The separator is punctuation, not words.
      setDone(
        [
          t('playlists.shareAdded', { name: share.name }),
          paths.length ? t('playlists.shareFromLibrary', { count: paths.length }) : null,
          wanted ? t('playlists.shareOnTheWay', { count: wanted }) : null,
          missing ? t('playlists.shareNotFetchable', { count: missing }) : null,
        ]
          .filter(Boolean)
          .join(' · '),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t('playlists.shareAddFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={close} title={t('playlists.sharedTitle')} size="sm">
      <div className="sharedPlaylist">
        {error && (
          <Text tone="danger" size="sm">
            {error}
          </Text>
        )}
        {!share && !error && (
          <Text tone="muted" size="sm">{t('playlists.shareOpening')}</Text>
        )}
        {share && (
          <>
            <div className="sharedPlaylist__head">
              {share.covers.length > 0 && (
                <div className="sharedPlaylist__mosaic" aria-hidden>
                  {share.covers.slice(0, 4).map((c, i) => (
                    <img key={i} src={c} alt="" />
                  ))}
                </div>
              )}
              <div className="sharedPlaylist__who">
                <h3 className="sharedPlaylist__name">{share.name}</h3>
                {/* Three whole phrases joined by punctuation rather than one
                    sentence: the last clause is conditional, and a translator
                    reorders inside each phrase without needing all of them. */}
                <Text tone="muted" size="sm">
                  {[
                    t('playlists.shareBy', { who: share.by }),
                    songCount(share.tracks.length),
                    haveCount > 0 ? t('playlists.shareAlreadyHave', { count: haveCount }) : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </Text>
                {share.description && (
                  <Text tone="muted" size="sm">
                    {share.description}
                  </Text>
                )}
              </div>
            </div>
            <ol className="sharedPlaylist__list">
              {rows.slice(0, 40).map(({ t, have }, i) => (
                <li key={`${t.artist}|${t.title}|${i}`} className="sharedPlaylist__row" data-have={have ? '' : undefined}>
                  <span className="sharedPlaylist__mark">{have ? <Check size={13} /> : <ListMusic size={13} />}</span>
                  <span className="sharedPlaylist__title">{t.title}</span>
                  <span className="sharedPlaylist__artist">{t.artist}</span>
                </li>
              ))}
            </ol>
            {rows.length > 40 && (
              <Text tone="muted" size="xs">{t('playlists.andMore', { count: rows.length - 40 })}</Text>
            )}
            {done ? (
              <Text size="sm">{done}</Text>
            ) : (
              <Text tone="muted" size="xs">{t('playlists.shareAddExplainer')}</Text>
            )}
            <div className="sharedPlaylist__actions">
              {done ? (
                <Button variant="solid" size="sm" onClick={close}>
                  {t('common.done')}
                </Button>
              ) : (
                <>
                  <Button variant="ghost" size="sm" onClick={close}>
                    {t('common.notNow')}
                  </Button>
                  <Button variant="solid" size="sm" disabled={busy} onClick={() => void add()}>
                    {busy ? t('playlists.shareAdding') : t('playlists.shareAddToMine')}
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
