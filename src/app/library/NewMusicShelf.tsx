import { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '@glacier/react';
import { Check, Pause, Play, Plus, Sparkles } from '@glacier/icons';
import { Shelf } from '../home/homeCards.tsx';
import { ShelfSkeleton } from '../ux/ShelfSkeleton.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchNewMusic, type NewMusicList, type NewMusicTrack } from '../api/newMusic.ts';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import type { AcquireTarget } from '../../plugins/types.ts';

/**
 * New music: the discovery pool, grouped and named by the model.
 *
 * The shelf sits under For-you on purpose, because the two are the same idea a
 * step apart. For-you holds what the collector already went and FETCHED and is
 * waiting on a listen to justify. This holds what it has only found - songs
 * nobody owns yet, harvested near what actually gets played, scored, and sorted
 * into themed sets.
 *
 * The pool behind it is several hundred songs deep and has never had a screen.
 * `GET /api/new-music` was written in August and no client ever called it; the
 * commit that added it touched only the server. Music Date shows the bought
 * ones, which is a far smaller set, so everything else was invisible.
 *
 * A playlist here is not a playlist you can play. Nothing in it is on the disk.
 * Tapping one opens what it holds, each song previewable where the catalogue
 * gave us a clip, and each one addable - which is the only verb that makes
 * sense for music you do not have.
 */
export function NewMusicShelf() {
  const { session } = useServerSession();
  const [lists, setLists] = useState<NewMusicList[] | null>(null);
  const [open, setOpen] = useState<NewMusicList | null>(null);

  useEffect(() => {
    if (!session) {
      setLists(null);
      return;
    }
    const ctrl = new AbortController();
    fetchNewMusic(session, ctrl.signal)
      .then((next) => {
        if (!ctrl.signal.aborted) setLists(next);
      })
      // Kept quiet, like every other feed on this page: a shelf that cannot
      // load is a shelf that is not there, not a page with an error on it.
      .catch(() => {
        if (!ctrl.signal.aborted) setLists([]);
      });
    return () => ctrl.abort();
  }, [session]);

  if (!session) return null;
  if (lists === null) return <ShelfSkeleton title="New music for you" kind="mix" count={3} />;

  return (
    <>
      {/* Shelf itself renders nothing at count 0, which is the whole of the
          empty state: no model, too thin a pool, or a first build still
          running all mean "not yet" and none of them is worth a message. */}
      <Shelf title="New music for you" count={lists.length}>
        {lists.map((list) => (
          <button
            key={list.id}
            type="button"
            className="mixCard"
            onClick={() => setOpen(list)}
          >
            <NewMusicCover list={list} />
            <span className="mixCardTitle">{list.title}</span>
            <span className="mixCardBlurb">
              {list.blurb || `${list.items.length} songs you do not own`}
            </span>
          </button>
        ))}
      </Shelf>

      {open && <NewMusicList_ list={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/**
 * Four covers in a square, from the catalogue's own art.
 *
 * Borrows `.mixCardCover` - the same 2x2 mosaic the made-for-you mixes use, so
 * the two shelves read as siblings and this costs no new layout. It cannot use
 * the MixCover COMPONENT, though: that takes owned Tracks and resolves library
 * artwork ids, and nothing here is in the library to have one.
 */
function NewMusicCover({ list }: { list: NewMusicList }) {
  const art = list.items
    .map((t) => t.cover)
    .filter(Boolean)
    .slice(0, 4);
  if (art.length === 0) {
    return (
      <span className="mixCardCover newMixCover" aria-hidden>
        <Sparkles size={22} />
      </span>
    );
  }
  return (
    <span className="mixCardCover newMixCover" data-count={art.length} aria-hidden>
      {art.map((src, i) => (
        <img key={i} src={src} alt="" loading="lazy" />
      ))}
    </span>
  );
}

/** What one set holds, and the two things you can do with a song in it. */
function NewMusicList_({ list, onClose }: { list: NewMusicList; onClose: () => void }) {
  const acquire = useAcquire();
  const downloads = useDownloadsOptional();
  const [taken, setTaken] = useState<Record<string, boolean>>({});
  const { playing, toggle, stop } = usePreview();

  useEffect(() => stop, [stop]);

  /*
   * The same two-step every other "get this" in the app does, and it has to
   * stay the same: with the importer on, a tap IS the download and putting the
   * generic chooser between them would be a dialog nobody asked for; with it
   * off, the chooser is right, because something else may still be able to get
   * the song.
   */
  const take = (t: NewMusicTrack) => {
    const target: AcquireTarget = { kind: 'track', title: t.title, artist: t.artist, url: t.url };
    const viaImporter = acquire.handlersFor(target).some((h) => h.pluginId === IMPORTER_PLUGIN_ID);
    if (viaImporter && downloads) void downloads.enqueue(t.url).catch(() => {});
    else acquire.acquire(target);
    setTaken((s) => ({ ...s, [t.id]: true }));
  };

  return (
    <Modal open onClose={onClose} title={list.title} description={list.blurb || undefined} size="md">
      <ol className="newMusicList">
        {list.items.map((t) => (
          <li key={t.id} className="newMusicRow">
            <button
              type="button"
              className="newMusicRow__art"
              disabled={!t.preview}
              aria-label={t.preview ? `Preview ${t.title}` : `No preview for ${t.title}`}
              onClick={() => toggle(t.id, t.preview)}
            >
              {t.cover ? <img src={t.cover} alt="" loading="lazy" /> : <span />}
              {t.preview && (
                <span className="newMusicRow__play" aria-hidden>
                  {playing === t.id ? <Pause size={16} /> : <Play size={16} />}
                </span>
              )}
            </button>
            <span className="newMusicRow__text">
              <span className="newMusicRow__title">{t.title}</span>
              <span className="newMusicRow__sub">
                {t.artist}
                {/* The honest reason it is here, which is the one thing a
                    recommendation should always be able to say. */}
                {t.seed ? ` · because you play ${t.seed}` : ''}
              </span>
            </span>
            <button
              type="button"
              className="newMusicRow__add"
              data-state={taken[t.id] ? 'added' : 'idle'}
              aria-label={taken[t.id] ? `${t.title} asked for` : `Add ${t.title}`}
              disabled={taken[t.id]}
              onClick={() => take(t)}
            >
              {taken[t.id] ? <Check size={16} /> : <Plus size={16} />}
            </button>
          </li>
        ))}
      </ol>
    </Modal>
  );
}

/**
 * One clip at a time, on one element.
 *
 * Small on purpose and local to this file. There are already two audio
 * auditions in the tree - WrongSongModal's and Music Date's warm pool - and
 * neither can do this: the first is built around library paths, the second
 * around a pool of local files with an autoplay gate and a meter. This plays a
 * remote thirty-second URL and nothing else, and it deliberately does NOT
 * touch the player, so whatever is on keeps playing underneath and the preview
 * is a second voice over it rather than an interruption.
 */
function usePreview() {
  const el = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);

  const stop = useCallback(() => {
    el.current?.pause();
    setPlaying(null);
  }, []);

  const toggle = useCallback(
    (id: string, url: string) => {
      if (!url) return;
      if (!el.current) {
        el.current = new Audio();
        el.current.addEventListener('ended', () => setPlaying(null));
      }
      const audio = el.current;
      if (playing === id) {
        audio.pause();
        setPlaying(null);
        return;
      }
      audio.src = url;
      setPlaying(id);
      // A refused play leaves the button lit with nothing behind it, which
      // reads as broken; the catch puts it back.
      void audio.play().catch(() => setPlaying(null));
    },
    [playing],
  );

  return { playing, toggle, stop };
}
