import { Button, IconButton, Input, Menu, MenuItem, Modal, Text } from '@glacier/react';
import { BookAudio, EllipsisVertical, Pencil, Play, Trash2, X } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { fireNativeHaptic } from '../core/haptics.ts';
import { useLibrary } from '../library/library.tsx';
import type { ShelfBook } from '../library/bookShelf.ts';
import { usePlaylists } from './playlists.tsx';
import { collectionBooks } from './collections.ts';
import { CoverWall } from './CoverWall.tsx';
import { notePlaylistPlayed } from './playlistRecency.ts';
import { setHeaderActions } from '../nav/headerActions.ts';
import { artSized } from '../server.ts';
import { formatTotal } from '../ux/format.ts';
import { EmptyArt } from '../ux/EmptyArt.tsx';
import type { Track } from '../core/tauri.ts';
import { useT } from '../i18n/LocaleShell.tsx';

interface CollectionPageProps {
  id: string;
  /** Receives the opened track and the collection's every section, in order. */
  onPlay: (track: Track, queue: Track[]) => void;
  /** Called when the collection this page is showing no longer exists. */
  onGone: () => void;
}

/**
 * One book collection, opened as a page.
 *
 * A collection IS a playlist (see collections.ts), and this is the playlist
 * page re-cut for books rather than the playlist page with a flag. The song
 * page's whole body is wrong for it: its rows resolve paths against the
 * SONGS, which hold no book files; its table draws a chapter as a track with
 * an album column; its shuffle would jumble twelve sections of one reading;
 * its suggestions, wants, covers and sharing all speak to music. What a
 * collection needs is the shelf's vocabulary - a book is one row, however
 * many files it is - over the same hero the shelf and every playlist wear.
 *
 * Playing it plays THROUGH: the first section of the first book, with every
 * section of every book queued behind it in collection order, so a long
 * drive can be three books end to end. A row plays from that book on.
 */
export function CollectionPage({ id, onPlay, onGone }: CollectionPageProps) {
  const t = useT();
  const { books } = useLibrary();
  const { playlists, rename, remove, removeTracks } = usePlaylists();
  const collection = playlists.find((p) => p.id === id);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Deleted from another device while open here: the heartbeat drops it from
  // the list and the page steps back rather than rendering against nothing.
  useEffect(() => {
    if (!collection) onGone();
  }, [collection, onGone]);

  // The books, in the order the list holds them. Keyed on the paths as a
  // string rather than the collection object: the store hands back a fresh
  // object every render.
  const memberKey = collection?.paths.join(',') ?? '';
  const shelf = useMemo(
    () => collectionBooks(memberKey ? memberKey.split(',') : [], books),
    [memberKey, books],
  );
  const queue = useMemo(() => shelf.flatMap((b) => b.tracks), [shelf]);
  const totalSeconds = useMemo(
    () => queue.reduce((sum, track) => sum + (track.duration ?? 0), 0),
    [queue],
  );
  // The face is the first book's: a collection is identified by what you
  // read first in it, the way a playlist is by its leading sleeve.
  const cover = shelf.find((b) => b.cover)?.cover ?? null;
  const covers = useMemo(() => shelf.map((b) => b.cover), [shelf]);

  /*
   * The hero scrolls away and the app's header picks up what it was carrying
   * - the same sentinel arrangement the shelf and the playlist page use.
   */
  const pageRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const root = pageRef.current;
    const mark = sentinelRef.current;
    if (!root || !mark) return;
    const observer = new IntersectionObserver(([entry]) => setStuck(!entry?.isIntersecting), {
      root,
      threshold: 0,
    });
    observer.observe(mark);
    return () => observer.disconnect();
  }, [collection?.id]);

  const handlers = useRef<{ playAll: () => void }>({ playAll: () => {} });
  const lentName = collection?.name ?? null;
  useEffect(() => {
    if (!stuck || !lentName) return;
    setHeaderActions({
      title: lentName,
      art: cover,
      glyph: cover ? null : BookAudio,
      play: () => handlers.current.playAll(),
      disabled: queue.length === 0,
    });
    return () => setHeaderActions(null);
  }, [stuck, lentName, cover, queue.length]);

  const playFrom = (book: ShelfBook) => {
    if (!collection) return;
    notePlaylistPlayed(collection.id);
    // From this book to the end of the collection: the rest of the running
    // order follows, the books before it do not.
    const at = queue.indexOf(book.tracks[0]!);
    const rest = at >= 0 ? queue.slice(at) : book.tracks;
    onPlay(rest[0]!, rest);
  };
  const playAll = () => {
    const first = shelf[0];
    if (first) playFrom(first);
  };
  handlers.current = { playAll };

  const commitRename = (event: FormEvent) => {
    event.preventDefault();
    if (renaming === null) return;
    const next = renaming.trim();
    if (next && collection) rename(collection.id, next);
    setRenaming(null);
  };

  // Undefined role means a local list or a server from before sharing -
  // yours. A collection a friend shared is read-only here, like their lists.
  const isOwner = !collection?.role || collection.role === 'owner';
  const canEdit = isOwner || collection?.role === 'editor';

  // Under every hook, for the reason PlaylistPage spells out at length: a
  // collection deleted from under this page returns null on the very next
  // render, and a hook below this line would be one fewer than before.
  if (!collection) return null;

  return (
    <div className="homePage libraryPage playlistPage collectionPage" ref={pageRef}>
      <header className="playlistHead songPageHead booksHead">
        <CoverWall artworks={covers} />
        <div className="playlistHead__cover" aria-hidden>
          <div className="tileSquircle playlistHead__mosaic booksHero">
            {cover ? (
              <img className="booksHero__cover" src={artSized(cover, 640) ?? cover} alt="" />
            ) : (
              <span className="booksHero__glyph">
                <BookAudio size={34} />
              </span>
            )}
          </div>
        </div>
        <div className="playlistHead__body">
          <Text tone="muted" size="xs" className="playlistHead__kicker">
            {t('books.collectionKicker')}
          </Text>
          <h2 className="playlistHead__name">{collection.name}</h2>
          <Text tone="muted" size="sm">
            {/* "3 books · 21 hr 4 min" - the running time is an optional
                tail, chosen by context, the way the shelf's own count is. */}
            {t('books.bookCount', {
              count: shelf.length,
              time: totalSeconds > 0 ? formatTotal(totalSeconds) : '',
              context: totalSeconds > 0 ? 'withTime' : undefined,
            })}
          </Text>
          <div className="playlistHead__actions">
            <Button variant="solid" size="sm" onClick={playAll} disabled={queue.length === 0}>
              <Play size={15} fill="currentColor" />
              {t('player.play')}
            </Button>
            {isOwner && (
              <Menu
                aria-label={t('books.collectionActions', { name: collection.name })}
                trigger={
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('books.collectionActions', { name: collection.name })}
                  >
                    <EllipsisVertical size={16} />
                  </IconButton>
                }
              >
                <MenuItem icon={<Pencil size={15} />} onSelect={() => setRenaming(collection.name)}>
                  {t('playlists.rename')}
                </MenuItem>
                <MenuItem icon={<Trash2 size={15} />} onSelect={() => setConfirmDelete(true)}>
                  {t('books.deleteCollection')}
                </MenuItem>
              </Menu>
            )}
          </div>
        </div>
      </header>
      <div ref={sentinelRef} className="songPageHead__sentinel" aria-hidden />

      {shelf.length === 0 ? (
        <div className="playlistEmpty emptyState emptyState--tall">
          <EmptyArt name="playlist" />
          <Text tone="muted">{t('books.collectionEmpty')}</Text>
        </div>
      ) : (
        <ol className="collectionRows" aria-label={t('books.collectionBooks')}>
          {shelf.map((book, i) => (
            <li key={book.key} className="collectionRow">
              <button
                type="button"
                className="collectionRow__main"
                onClick={() => playFrom(book)}
                aria-label={t('books.startAria', { title: book.title })}
              >
                <span className="collectionRow__n" aria-hidden>
                  {i + 1}
                </span>
                <span className="collectionRow__cover" aria-hidden>
                  {book.cover ? (
                    <img src={book.cover} alt="" loading="lazy" />
                  ) : (
                    <BookAudio size={18} />
                  )}
                </span>
                <span className="collectionRow__text">
                  <span className="collectionRow__title">{book.title}</span>
                  <span className="collectionRow__sub">
                    {book.author}
                    {' · '}
                    {t('books.chapterCount', { count: book.chapters.length })}
                  </span>
                </span>
              </button>
              {/* Sibling of the row, not inside it: a button within a button
                  is not a thing the browser will honour. */}
              {canEdit && (
                <IconButton
                  variant="ghost"
                  size="sm"
                  className="collectionRow__remove"
                  aria-label={t('books.removeFromCollection', { title: book.title })}
                  onClick={() => removeTracks(collection.id, book.tracks.map((x) => x.path))}
                >
                  <X size={15} />
                </IconButton>
              )}
            </li>
          ))}
        </ol>
      )}

      <Modal
        open={renaming !== null}
        onClose={() => setRenaming(null)}
        title={t('playlists.renameTitle')}
        size="sm"
      >
        <form className="playlistCreate" onSubmit={commitRename}>
          <Input
            autoFocus
            value={renaming ?? ''}
            onChange={(e) => setRenaming(e.currentTarget.value)}
            aria-label={t('books.collectionNameField')}
          />
          <Button type="submit" variant="solid">
            {t('common.save')}
          </Button>
        </form>
      </Modal>

      {/* Deleting is the one action here with nothing behind it, so it asks.
          The books are untouched: they were only ever named here. */}
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={t('playlists.deleteConfirmTitle', { name: collection.name })}
        size="sm"
      >
        <div className="playlistConfirm">
          <Text tone="muted" size="sm">
            {t('books.deleteCollectionExplain')}
          </Text>
          <div className="playlistConfirm__actions">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
              {t('playlists.keepIt')}
            </Button>
            <Button
              variant="solid"
              onClick={() => {
                fireNativeHaptic('warning');
                setConfirmDelete(false);
                remove(collection.id);
                onGone();
              }}
            >
              {t('common.delete')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
