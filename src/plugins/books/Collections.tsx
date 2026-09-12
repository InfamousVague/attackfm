import { Button, ContextMenu, Input, MenuItem, Modal, Text } from '@glacier/react';
import { BookAudio, Pencil, Plus, Trash2 } from '@glacier/icons';
import { useMemo, useState, type FormEvent } from 'react';
import type { Track } from '../../app/core/tauri.ts';
import { useT } from '../../app/i18n/LocaleShell.tsx';
import { openPlaylistById } from '../../app/nav/playlistDoor.ts';
import {
  BOOK_COLLECTION_FOLDER,
  collectionBooks,
  isBookCollection,
} from '../../app/playlists/collections.ts';
import { usePlaylists, type Playlist } from '../../app/playlists/playlists.tsx';
import { useHoldToMenu } from '../../app/ux/holdToMenu.ts';

/**
 * Collections, at the top of the Books shelf.
 *
 * Playlists for books: a set of readings to play through in order, or just
 * to keep together - the bedtime ones, the ones for the long drive, the
 * series in the order it goes. Each IS a playlist in the store, filed under
 * the reserved folder (collections.ts), so it syncs, renames and deletes
 * the way any list does; what is different is only which room draws it,
 * and this is that room. The Library's playlist shelf never shows one, and
 * this shelf never shows a music list - the same folder decides both.
 *
 * The tiles wear the playlist tile's own classes on purpose: a collection
 * is the same kind of door as a playlist and should look like one.
 */
export function Collections({
  books,
  onOpen,
}: {
  /** Every book file the library holds - what the tiles resolve against. */
  books: readonly Track[];
  /** Opens one collection as a page. */
  onOpen?: ((id: string) => void) | undefined;
}) {
  const t = useT();
  const { playlists, create, rename, remove } = usePlaylists();
  const collections = useMemo(() => playlists.filter(isBookCollection), [playlists]);
  // The same hold the playlist shelf uses, for the same reason: the kit's
  // long-press opens the menu and then lets the tile take the release.
  const hold = useHoldToMenu((from) => from.closest('.playlistTileMenuTarget'));
  const [making, setMaking] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<{ id: string; name: string } | null>(null);

  const open = (id: string) => {
    if (onOpen) onOpen(id);
    else openPlaylistById(id);
  };

  return (
    <section className="discoverSection bookCollections">
      <h2 className="discoverSection__title">{t('books.collections')}</h2>
      <Text tone="muted" size="sm" className="bookCollections__blurb">
        {t('books.collectionsBlurb')}
      </Text>
      <div className="showcaseGrid" {...hold}>
        {collections.map((c) => (
          <CollectionTile
            key={c.id}
            collection={c}
            books={books}
            onOpen={() => open(c.id)}
            onRename={() => setRenaming({ id: c.id, name: c.name })}
            onDelete={() => setDeleting({ id: c.id, name: c.name })}
          />
        ))}
        <button type="button" className="playlistTile" onClick={() => setMaking(true)}>
          <div className="tileSquircle tileAdd" aria-hidden>
            <Plus size={24} />
          </div>
          <span className="playlistTileName">{t('books.newCollection')}</span>
        </button>
      </div>

      {making && (
        <NameDialog
          title={t('books.newCollection')}
          action={t('playlists.create')}
          onClose={() => setMaking(false)}
          onDone={async (name) => {
            // Born in the folder, not filed a beat later - see CreateOptions.
            const id = await create(name, [], { folder: BOOK_COLLECTION_FOLDER });
            setMaking(false);
            open(id);
          }}
        />
      )}
      {renaming && (
        <NameDialog
          title={t('playlists.renameTitle')}
          action={t('common.save')}
          initial={renaming.name}
          onClose={() => setRenaming(null)}
          onDone={(name) => {
            rename(renaming.id, name);
            setRenaming(null);
          }}
        />
      )}
      {deleting && (
        <Modal
          open
          onClose={() => setDeleting(null)}
          title={t('playlists.deleteConfirmTitle', { name: deleting.name })}
          size="sm"
        >
          <Text tone="muted" size="sm">
            {t('books.deleteCollectionExplain')}
          </Text>
          <div className="playlistDeleteActions">
            <Button variant="ghost" size="sm" onClick={() => setDeleting(null)}>
              {t('playlists.keepIt')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                remove(deleting.id);
                setDeleting(null);
              }}
            >
              <Trash2 size={15} />
              <span>{t('common.delete')}</span>
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/**
 * One tile: the first book's sleeve, the name, how many books. Its hold
 * menu carries the two verbs a collection has from the shelf; adding and
 * removing books is done from the books themselves, and from the page.
 */
function CollectionTile({
  collection,
  books,
  onOpen,
  onRename,
  onDelete,
}: {
  collection: Playlist;
  books: readonly Track[];
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const shelf = useMemo(() => collectionBooks(collection.paths, books), [collection.paths, books]);
  const cover = shelf.find((b) => b.cover)?.cover ?? null;
  // Only the owner renames or deletes; a collection a friend shared is a
  // door and nothing more, like their playlists on the Library.
  const mine = !collection.role || collection.role === 'owner';
  const tile = (
    <button type="button" className="playlistTile" onClick={onOpen}>
      {cover ? (
        <div className="tileSquircle tileCoverFull" aria-hidden>
          <img src={cover} alt="" loading="lazy" />
        </div>
      ) : (
        <div className="tileSquircle tileRecent" aria-hidden>
          <BookAudio size={24} />
        </div>
      )}
      <span className="playlistTileName">{collection.name}</span>
      <span className="playlistTileCaption">{t('books.bookCount', { count: shelf.length })}</span>
    </button>
  );
  if (!mine) return tile;
  return (
    <ContextMenu
      aria-label={t('books.collectionActions', { name: collection.name })}
      className="playlistTileMenuTarget"
      content={
        <>
          <MenuItem icon={<Pencil size={15} />} onSelect={onRename}>
            {t('playlists.rename')}
          </MenuItem>
          <MenuItem icon={<Trash2 size={15} />} onSelect={onDelete}>
            {t('books.deleteCollection')}
          </MenuItem>
        </>
      }
    >
      {tile}
    </ContextMenu>
  );
}

/** One field and one verb: naming a collection, new or again. */
function NameDialog({
  title,
  action,
  initial = '',
  onClose,
  onDone,
}: {
  title: string;
  action: string;
  initial?: string;
  onClose: () => void;
  onDone: (name: string) => void | Promise<void>;
}) {
  const t = useT();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await onDone(clean);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={title} size="sm">
      <form className="playlistCreate" onSubmit={(e) => void submit(e)}>
        <Input
          autoFocus
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder={t('books.collectionNamePrompt')}
          aria-label={t('books.collectionNameField')}
          disabled={busy}
        />
        <Button type="submit" variant="solid" disabled={busy || !name.trim()}>
          {action}
        </Button>
      </form>
    </Modal>
  );
}
