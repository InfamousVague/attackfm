import {
  AlertDialog,
  IconButton,
  SegmentedControl,
  Text,
  TreeView,
  type TreeItem,
} from '@glacier/react';
import { Disc3, Music, Trash2, User } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { offlineEntries, onOfflineChange, unpinTrack, type OfflineEntry } from './offline.ts';
import { autoCachedKeys, denyKey, onCacheChange } from './autoCache.ts';
import { artSized, loadCachedIndex, remotePath, toTrack } from '../server.ts';
import { isTauri, type Track } from '../core/tauri.ts';
import { qualityLabel, qualityOfPath } from '../cache/cacheQuality.ts';
import { formatBytes } from '../ux/format.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { usePlayNowOptional } from '../player/playNow.tsx';

/**
 * The Files chunk: everything held on the device, as a browser.
 *
 * This replaces three flat lists that each held one lens on the same folder -
 * Offline's "kept by hand", Storage's "by artist" bars and its "largest
 * files" - with one place that has all three: a tree by artist and album
 * (which is how people remember music), a Biggest view (which is how they
 * decide what goes), and delete on every row.
 *
 * Deleting an automatic download DENIES it (autoCache.denyKey) as well as
 * removing the file. Without that the delete is a promise the next sweep
 * quietly breaks by downloading the song right back - which is why the old
 * Storage pane refused to offer delete on cache rows at all. The denial is
 * what upgrades the refusal into a real answer.
 *
 * The disk stays the index: rows come from offlineEntries() every time, and
 * the tree is rebuilt when the folder changes. Nothing here keeps its own
 * ledger.
 */

type View = 'tree' | 'biggest';

interface Row {
  key: string;
  bytes: number;
  track: Track | null;
  auto: boolean;
  /** The file on disk. Its extension is the record of what quality it holds.
   *  Optional because the test fixture has no real folder behind it. */
  file?: string;
}

/**
 * What a held file's own quality reads as.
 *
 * `qualityLabel` answers in kbps for a transcode and with the word "Original"
 * for a file nothing touched - and that word is the only English in it. The
 * helper is shared with the sweep and the pinner, neither of which has a
 * translator to hand, so the number keeps coming from there and the word comes
 * from here. The kbps stays in Latin digits for the same reason `formatClock`
 * does: it is a spec, read next to a filename, not a sentence.
 */
function fileQuality(file: string, t: ReturnType<typeof useT>): string {
  const quality = qualityOfPath(file);
  return quality === 0 ? t('downloads.qualityOriginal') : qualityLabel(quality);
}

/** What a delete is about to take, for the confirm dialog. */
interface PendingDelete {
  label: string;
  rows: Row[];
}

/**
 * DEV-ONLY fixture, so the browser preview - which holds no files and signs
 * into nothing - can exercise the tree, the filters and the delete flow.
 * Absent in production builds; the flag never ships set.
 */
function readFixture(): Row[] | null {
  if (!import.meta.env.DEV) return null;
  try {
    const raw = localStorage.getItem('attackfm-files-fixture');
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      key: string;
      bytes: number;
      auto: boolean;
      title: string;
      artist: string;
      album: string;
    }[];
    return parsed.map((r) => ({
      key: r.key,
      bytes: r.bytes,
      auto: r.auto,
      track: { path: r.key, title: r.title, artist: r.artist, album: r.album } as Track,
    }));
  } catch {
    return null;
  }
}

export function FilesOnDevice() {
  const t = useT();
  const { tracks } = useLibrary();
  const [entries, setEntries] = useState<OfflineEntry[]>([]);
  const [owned, setOwned] = useState<Set<string>>(() => autoCachedKeys());
  const [view, setView] = useState<View>('tree');
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [fixture, setFixture] = useState<Row[] | null>(readFixture);

  useEffect(() => {
    // Stamped per read: a burst of deletes or pins can resolve out of order,
    // and only the freshest folder listing may land.
    let stamp = 0;
    const refresh = () => {
      const mine = ++stamp;
      void offlineEntries().then((e) => {
        if (mine === stamp) setEntries(e);
      });
      setOwned(autoCachedKeys());
    };
    refresh();
    const offA = onOfflineChange(refresh);
    const offB = onCacheChange(refresh);
    return () => {
      offA();
      offB();
    };
  }, []);

  const { session } = useServerSession();
  const byPath = useMemo(() => new Map(tracks.map((tr) => [tr.path, tr] as const)), [tracks]);
  // The sweep resolves songs through the CACHED index, and so must this view:
  // right after a sign-in the live library can lag it, and every fresh
  // download briefly read as "no longer in the library" - the one thing it
  // certainly was not.
  const byIndex = useMemo(() => {
    if (!session) return new Map<string, Track>();
    const m = new Map<string, Track>();
    for (const tr of loadCachedIndex(session.url).tracks) m.set(remotePath(tr.id), toTrack(session, tr));
    return m;
  }, [session]);
  const resolve = (key: string): Track | null => byPath.get(key) ?? byIndex.get(key) ?? null;

  const rows: Row[] = useMemo(() => {
    if (fixture) return fixture;
    return entries.map((e) => ({
      key: e.key,
      bytes: e.bytes,
      track: resolve(e.key),
      auto: owned.has(e.key),
      file: e.path,
    }));
  }, [entries, byPath, owned, fixture]);

  const remove = (batch: Row[]) => {
    if (fixture) {
      // The fixture deletes in memory, so the interaction is testable where
      // the real folder does not exist.
      const gone = new Set(batch.map((r) => r.key));
      setFixture((cur) => (cur ? cur.filter((r) => !gone.has(r.key)) : cur));
      return;
    }
    for (const row of batch) {
      // Denied FIRST: if the unpin lands and the deny throws, the worst case
      // is a comeback; the other order can deny a song it failed to delete.
      if (row.auto) denyKey(row.key);
      void unpinTrack(row.key);
    }
  };

  /** Deletes of one file act at once; a folder's worth asks first. */
  const requestDelete = (label: string, batch: Row[]) => {
    if (batch.length === 1) remove(batch);
    else setPending({ label, rows: batch });
  };

  const tree: TreeItem[] = useMemo(() => {
    interface AlbumSlot {
      rows: Row[];
      bytes: number;
      art: string | null;
    }
    interface ArtistSlot {
      albums: Map<string, AlbumSlot>;
      bytes: number;
      count: number;
      art: string | null;
    }
    const artists = new Map<string, ArtistSlot>();
    for (const row of rows) {
      // The heading for files whose song the library no longer knows. It is
      // the grouping key as well as the label, which is harmless: the key
      // lives only for as long as this memo, and the memo is rebuilt when the
      // language changes.
      const artist = row.track?.artist ?? t('downloads.notInLibrary');
      const album = row.track?.album ?? '';
      const a = artists.get(artist) ?? { albums: new Map(), bytes: 0, count: 0, art: null };
      a.bytes += row.bytes;
      a.count += 1;
      if (!a.art && row.track?.artwork) a.art = row.track.artwork;
      const al = a.albums.get(album) ?? { rows: [], bytes: 0, art: null };
      al.rows.push(row);
      al.bytes += row.bytes;
      if (!al.art && row.track?.artwork) al.art = row.track.artwork;
      a.albums.set(album, al);
      artists.set(artist, a);
    }

    const songItem = (row: Row): TreeItem => ({
      id: row.key,
      label: (
        <span className="deviceFiles__label">
          <span className="deviceFiles__name">{row.track?.title ?? row.key}</span>
          <span className="deviceFiles__meta">
            {formatBytes(row.bytes)}
            {' · '}
            {row.auto ? t('downloads.badgeAutomatic') : t('downloads.kept')}
            {/* The only place the quality of a specific file is visible. Worth
                showing because a held file always beats the setting at playback:
                change the setting and these songs keep what they have until the
                cache works through them, and without this there is nothing to
                read that explains why. */}
            {row.file ? ` · ${fileQuality(row.file, t)}` : ''}
          </span>
        </span>
      ),
      icon: <Music size={14} aria-hidden />,
      trailing: (
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={t('downloads.deleteFile', {
            title: row.track?.title ?? t('downloads.thisFile'),
          })}
          onClick={() => requestDelete(row.track?.title ?? t('downloads.thisFile'), [row])}
        >
          <Trash2 size={14} />
        </IconButton>
      ),
    });

    return [...artists.entries()]
      .sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([artist, a]) => {
        const albums = [...a.albums.entries()].sort((x, y) => y[1].bytes - x[1].bytes);
        const single = albums.length === 1;
        return {
          id: `artist:${artist}`,
          label: (
            <span className="deviceFiles__label">
              <span className="deviceFiles__name">{artist}</span>
              <span className="deviceFiles__meta">
                {t('downloads.songsAndSize', { count: a.count, size: formatBytes(a.bytes) })}
              </span>
            </span>
          ),
          icon: <FileArt art={a.art} circle glyph={<User size={13} aria-hidden />} />,
          trailing: (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={t('downloads.deleteArtist', { artist })}
              onClick={() =>
                requestDelete(
                  artist,
                  albums.flatMap(([, al]) => al.rows),
                )
              }
            >
              <Trash2 size={14} />
            </IconButton>
          ),
          // A one-album artist skips the album layer: a folder holding one
          // folder is a click that buys nothing.
          children: single
            ? albums[0]![1].rows.sort((x, y) => y.bytes - x.bytes).map(songItem)
            : albums.map(([album, al]) => ({
                id: `album:${artist}:${album}`,
                label: (
                  <span className="deviceFiles__label">
                    <span className="deviceFiles__name">{album || t('downloads.singles')}</span>
                    <span className="deviceFiles__meta">
                      {t('downloads.songsAndSize', {
                        count: al.rows.length,
                        size: formatBytes(al.bytes),
                      })}
                    </span>
                  </span>
                ),
                icon: <FileArt art={al.art} glyph={<Disc3 size={13} aria-hidden />} />,
                trailing: (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={t('downloads.deleteAlbum', { album: album || t('downloads.singles') })}
                    onClick={() => requestDelete(album || t('downloads.singles'), al.rows)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                ),
                children: [...al.rows].sort((x, y) => y.bytes - x.bytes).map(songItem),
              })),
        };
      });
    // requestDelete is stable in spirit (setState + module calls); listing rows
    // alone keeps the tree from rebuilding on every render. `t` is here because
    // every label in the tree came out of it: without it the tree keeps the
    // language it was built in until the folder next changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, t]);

  /*
   * Every row here is, by definition, a file sitting on this device - so a tap
   * plays it. The delete button rides in `trailing`, which TreeView isolates
   * from row activation, so the destructive verb cannot be hit by the gesture
   * that starts a song.
   *
   * A row whose `track` is null ("No longer in the library") stays inert: the
   * bytes are still on disk but nothing knows what they are, and a click that
   * did nothing would read as a bug rather than as an answer.
   */
  const playNow = usePlayNowOptional();
  const playRow = useCallback(
    (id: string) => {
      const key = id.startsWith('big:') ? id.slice(4) : id;
      const row = rows.find((r) => r.key === key);
      if (row?.track && playNow) playNow(row.track);
    },
    [rows, playNow],
  );

  const biggest: TreeItem[] = useMemo(() => {
    return [...rows]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 50)
      .map((row) => ({
        id: `big:${row.key}`,
        label: (
          <span className="deviceFiles__label">
            <span className="deviceFiles__name">{row.track?.title ?? row.key}</span>
            <span className="deviceFiles__meta">
              {t('downloads.artistAndSize', {
                artist: row.track?.artist ?? t('downloads.notInLibrary'),
                size: formatBytes(row.bytes),
              })}
              {' · '}
              {row.auto ? t('downloads.badgeAutomatic') : t('downloads.kept')}
            </span>
          </span>
        ),
        icon: <FileArt art={row.track?.artwork ?? null} glyph={<Music size={13} aria-hidden />} />,
        trailing: (
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={t('downloads.deleteFile', {
              title: row.track?.title ?? t('downloads.thisFile'),
            })}
            onClick={() => requestDelete(row.track?.title ?? t('downloads.thisFile'), [row])}
          >
            <Trash2 size={14} />
          </IconButton>
        ),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, t]);

  if (!isTauri() && !fixture) {
    return (
      <Text size="sm" tone="muted">
        {t('downloads.browserKeepsNothing')}
      </Text>
    );
  }

  if (rows.length === 0) {
    return (
      <Text size="sm" tone="muted">
        {t('downloads.deviceEmpty')}
      </Text>
    );
  }

  const pendingBytes = pending?.rows.reduce((n, r) => n + r.bytes, 0) ?? 0;
  const pendingAuto = pending?.rows.filter((r) => r.auto).length ?? 0;

  return (
    <div className="deviceFiles">
      <SegmentedControl
        aria-label={t('downloads.viewLabel')}
        size="sm"
        fullWidth
        value={view}
        options={[
          { value: 'tree', label: t('downloads.viewByArtist') },
          { value: 'biggest', label: t('downloads.viewBiggest') },
        ]}
        onValueChange={(next) => setView(next as View)}
      />

      <TreeView
        aria-label={view === 'tree' ? t('downloads.treeByArtist') : t('downloads.treeBiggest')}
        items={view === 'tree' ? tree : biggest}
        className="deviceFiles__tree"
        onSelect={playRow}
      />

      <Text size="xs" tone="subtle">
        {t('downloads.deleteExplainer')}
      </Text>

      {/* The dialog's body is three sentences with a key each, rather than one
          entry, because the middle one only appears for automatic downloads.
          Each is whole on its own, so a translator is never handed a fragment
          and left to guess what follows it. */}
      <AlertDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        tone="danger"
        title={t('downloads.deleteConfirmTitle', { what: pending?.label ?? '' })}
        description={
          pending
            ? [
                t('downloads.deleteConfirmFreed', {
                  count: pending.rows.length,
                  size: formatBytes(pendingBytes),
                }),
                pendingAuto > 0 ? t('downloads.deleteConfirmAuto') : null,
                t('downloads.deleteConfirmLibrary'),
              ]
                .filter(Boolean)
                .join(' ')
            : ''
        }
        actionLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onAction={() => {
          if (pending) remove(pending.rows);
          setPending(null);
        }}
      />
    </div>
  );
}

/** A cover thumb for a row - round for a person, square for a record. */
function FileArt({
  art,
  glyph,
  circle,
}: {
  art: string | null;
  glyph: React.ReactNode;
  circle?: boolean;
}) {
  const src = artSized(art, 160);
  return (
    <span className="deviceFiles__art" data-circle={circle || undefined}>
      {src ? <img src={src} alt="" loading="lazy" /> : glyph}
    </span>
  );
}
