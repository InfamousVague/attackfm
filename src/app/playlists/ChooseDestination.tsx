import { Modal, Text } from '@glacier/react';
import { Heart, ListMusic, Plus } from '@glacier/icons';
import { useState } from 'react';
import { usePlaylists } from './playlists.tsx';
import type { FileDestination } from '../downloads/filePlan.ts';

/**
 * Where should this song go, asked BEFORE it exists.
 *
 * The add-to-playlist panel next door cannot answer this: it takes a Track,
 * and the thing being filed here has not been downloaded yet, let alone
 * indexed. So this asks about a destination rather than about a song - the
 * same question, one step earlier - and hands back a plan for whoever is
 * starting the download.
 *
 * Deliberately short: Liked, the lists you already have, and a new one. A song
 * you have not heard yet is not the moment for a filing system.
 */
export function ChooseDestination({
  open,
  title,
  onClose,
  onChoose,
}: {
  open: boolean;
  /** The song being added, so the sheet can name what it is filing. */
  title: string;
  onClose: () => void;
  onChoose: (dest: FileDestination | null) => void;
}) {
  const { playlists, create } = usePlaylists();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const pick = (dest: FileDestination | null) => {
    onChoose(dest);
    onClose();
  };

  const makeAndPick = async () => {
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      // Born empty: the song that prompted it is not in the library yet, so
      // there is no path to hand the new list. It arrives when it downloads.
      const id = await create(clean);
      pick({ kind: 'playlist', id, name: clean });
    } finally {
      setBusy(false);
      setNaming(false);
      setName('');
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add to" size="sm">
      <div className="chooseDest">
        <Text tone="muted" size="sm" className="chooseDest__what">
          {title}
        </Text>

        <button type="button" className="chooseDest__row" onClick={() => pick({ kind: 'liked' })}>
          <span className="chooseDest__icon" data-tint="pink" aria-hidden>
            <Heart size={16} />
          </span>
          <span className="chooseDest__label">Liked songs</span>
        </button>

        {playlists.map((p) => (
          <button
            key={p.id}
            type="button"
            className="chooseDest__row"
            onClick={() => pick({ kind: 'playlist', id: p.id, name: p.name })}
          >
            <span className="chooseDest__icon" aria-hidden>
              <ListMusic size={16} />
            </span>
            <span className="chooseDest__label">{p.name}</span>
          </button>
        ))}

        {naming ? (
          <form
            className="chooseDest__new"
            onSubmit={(e) => {
              e.preventDefault();
              void makeAndPick();
            }}
          >
            <input
              className="chooseDest__field"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Playlist name"
              aria-label="Playlist name"
              autoFocus
            />
          </form>
        ) : (
          <button type="button" className="chooseDest__row" onClick={() => setNaming(true)}>
            <span className="chooseDest__icon" aria-hidden>
              <Plus size={16} />
            </span>
            <span className="chooseDest__label">New playlist…</span>
          </button>
        )}

        {/* The way out that is not a destination: the song still lands in the
            library, which is what Add did before any of this existed. */}
        <button type="button" className="chooseDest__plain" onClick={() => pick(null)}>
          Just add it to my library
        </button>
      </div>
    </Modal>
  );
}
