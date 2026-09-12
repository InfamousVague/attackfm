import { Button, Drawer, Input, Text, useToast } from '@glacier/react';
import { BookAudio, Check, Plus } from '@glacier/icons';
import { useMemo, useState, type FormEvent } from 'react';
import { fireNativeHaptic } from '../../app/core/haptics.ts';
import type { Track } from '../../app/core/tauri.ts';
import { useT } from '../../app/i18n/LocaleShell.tsx';
import type { ShelfBook } from '../../app/library/bookShelf.ts';
import {
  BOOK_COLLECTION_FOLDER,
  bookInCollection,
  collectionBooks,
  isBookCollection,
} from '../../app/playlists/collections.ts';
import { usePlaylists } from '../../app/playlists/playlists.tsx';

/**
 * "Add to collection", the way the app files a song into a playlist: one
 * sheet listing the collections, each row saying plainly whether the book is
 * already in it, a tap toggling it in or out. The whole book - every section,
 * in reading order - never a chapter; a collection is a list of readings,
 * and half a reading in one is a mistake nobody means to make.
 *
 * Making a new one is a field at the foot of the same sheet rather than a
 * second dialog: a modal opened from a drawer is destroyed with its trigger
 * (see the note on Modal-in-Modal in the handbook), and the book that
 * prompted the new collection goes straight in.
 */
export function AddToCollectionDialog({
  book,
  books,
  open,
  onClose,
}: {
  book: ShelfBook;
  /** Every book file in the library, for each row's cover and count. */
  books: readonly Track[];
  open: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const { toast } = useToast();
  const { playlists, addTracks, removeTracks, create } = usePlaylists();
  const collections = useMemo(() => playlists.filter(isBookCollection), [playlists]);
  const paths = useMemo(() => book.tracks.map((x) => x.path), [book]);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const makeNew = async (e: FormEvent) => {
    e.preventDefault();
    const clean = name.trim();
    if (!clean || busy) return;
    setBusy(true);
    try {
      await create(clean, paths, { folder: BOOK_COLLECTION_FOLDER });
      fireNativeHaptic('success');
      toast({ message: t('books.addedToCollection', { name: clean }) });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      side="bottom"
      size="lg"
      title={t('books.addToCollectionTitle')}
      className="addPlaylistSheet"
    >
      <div className="addPlaylist">
        <div className="addPlaylist__head">
          <Text size="sm" className="addPlaylist__song">
            {t('books.addBookTo', { title: book.title })}
          </Text>
        </div>

        <div className="addPlaylist__list">
          {collections.length === 0 && (
            <Text tone="muted" size="sm" className="addPlaylist__empty">
              {t('books.noCollectionsYet')}
            </Text>
          )}
          {collections.map((c) => {
            const has = bookInCollection(book, c.paths);
            const shelf = collectionBooks(c.paths, books);
            const cover = shelf.find((b) => b.cover)?.cover ?? null;
            // A friend's collection is a door, not a drawer: nothing to file
            // into, so the row says so by not being a toggle at all.
            const editable = !c.role || c.role === 'owner' || c.role === 'editor';
            return (
              <button
                key={c.id}
                type="button"
                className="addPlaylistRow"
                data-in={has || undefined}
                aria-pressed={has}
                disabled={!editable}
                onClick={() => {
                  // In with a celebration, out with words and a way back -
                  // the rule the heart and the playlist rows already keep.
                  if (has) {
                    removeTracks(c.id, paths);
                    toast({
                      message: t('books.removedFromCollection', { name: c.name }),
                      action: { label: t('common.undo'), onPress: () => addTracks(c.id, paths) },
                    });
                  } else {
                    addTracks(c.id, paths);
                    fireNativeHaptic('success');
                    toast({ message: t('books.addedToCollection', { name: c.name }) });
                  }
                }}
              >
                <span className="addPlaylistRow__icon addPlaylistRow__icon--art">
                  {cover ? (
                    <span className="tileSquircle tileCoverFull" aria-hidden>
                      <img src={cover} alt="" loading="lazy" />
                    </span>
                  ) : (
                    <span className="tileSquircle tileRecent" aria-hidden>
                      <BookAudio size={15} />
                    </span>
                  )}
                </span>
                <span className="addPlaylistRow__body">
                  <span className="addPlaylistRow__name">{c.name}</span>
                  <span className="addPlaylistRow__meta">
                    {t('books.bookCount', { count: shelf.length })}
                  </span>
                </span>
                {has && (
                  <span className="addPlaylistRow__check" aria-hidden>
                    <Check size={16} />
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {naming ? (
          <form className="playlistCreate addCollection__new" onSubmit={(e) => void makeNew(e)}>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              placeholder={t('books.collectionNamePrompt')}
              aria-label={t('books.collectionNameField')}
              disabled={busy}
            />
            <Button type="submit" variant="solid" disabled={busy || !name.trim()}>
              {t('playlists.create')}
            </Button>
          </form>
        ) : (
          <button type="button" className="addPlaylist__new" onClick={() => setNaming(true)}>
            <span className="addPlaylist__newIcon">
              <Plus size={16} />
            </span>
            {t('books.newCollection')}
          </button>
        )}
      </div>
    </Drawer>
  );
}
