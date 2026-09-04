import { useEffect, useState } from 'react';
import { Modal } from '@glacier/react';
import { Check, Pause, Play, Plus } from '@glacier/icons';
import { usePreview } from '../ux/previewAudio.ts';
import type { NewMusicList, NewMusicTrack } from '../api/newMusic.ts';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import type { AcquireTarget } from '../../plugins/types.ts';

/**
 * What one new-music set holds, and the two things you can do with a song in
 * it: hear the catalogue's thirty seconds, and ask for the whole thing.
 *
 * Its own file because two surfaces open it - the New-for-you shelf and the
 * Discover hero, when the hero's lead is one of these lists - and the feed
 * provider owns which list is open so the two cannot disagree.
 */
export function NewMusicListModal({ list, onClose }: { list: NewMusicList; onClose: () => void }) {
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
