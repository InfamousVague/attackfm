import {
  AlertDialog,
  IconButton,
  SegmentedControl,
  Text,
  TreeView,
  type TreeItem,
} from '@glacier/react';
import { Disc3, Music, Trash2, User } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { offlineEntries, onOfflineChange, unpinTrack, type OfflineEntry } from './offline.ts';
import { autoCachedKeys, denyKey, onCacheChange } from './autoCache.ts';
import { artSized } from './server.ts';
import { isTauri, type Track } from './tauri.ts';

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

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

type View = 'tree' | 'biggest';

interface Row {
  key: string;
  bytes: number;
  track: Track | null;
  auto: boolean;
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
  const { tracks } = useLibrary();
  const [entries, setEntries] = useState<OfflineEntry[]>([]);
  const [owned, setOwned] = useState<Set<string>>(() => autoCachedKeys());
  const [view, setView] = useState<View>('tree');
  const [pending, setPending] = useState<PendingDelete | null>(null);
  const [fixture, setFixture] = useState<Row[] | null>(readFixture);

  useEffect(() => {
    const refresh = () => {
      void offlineEntries().then(setEntries);
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

  const byPath = useMemo(() => new Map(tracks.map((t) => [t.path, t] as const)), [tracks]);

  const rows: Row[] = useMemo(() => {
    if (fixture) return fixture;
    return entries.map((e) => ({
      key: e.key,
      bytes: e.bytes,
      track: byPath.get(e.key) ?? null,
      auto: owned.has(e.key),
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
      const artist = row.track?.artist ?? 'No longer in the library';
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
            {size(row.bytes)}
            {row.auto ? ' · automatic' : ' · kept'}
          </span>
        </span>
      ),
      icon: <Music size={14} aria-hidden />,
      trailing: (
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={`Delete ${row.track?.title ?? 'this file'} from this device`}
          onClick={() => requestDelete(row.track?.title ?? 'this file', [row])}
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
                {a.count} {a.count === 1 ? 'song' : 'songs'} · {size(a.bytes)}
              </span>
            </span>
          ),
          icon: <FileArt art={a.art} circle glyph={<User size={13} aria-hidden />} />,
          trailing: (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label={`Delete everything by ${artist} from this device`}
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
                    <span className="deviceFiles__name">{album || 'Singles'}</span>
                    <span className="deviceFiles__meta">
                      {al.rows.length} {al.rows.length === 1 ? 'song' : 'songs'} · {size(al.bytes)}
                    </span>
                  </span>
                ),
                icon: <FileArt art={al.art} glyph={<Disc3 size={13} aria-hidden />} />,
                trailing: (
                  <IconButton
                    variant="ghost"
                    size="sm"
                    aria-label={`Delete the album ${album || 'Singles'} from this device`}
                    onClick={() => requestDelete(album || 'Singles', al.rows)}
                  >
                    <Trash2 size={14} />
                  </IconButton>
                ),
                children: [...al.rows].sort((x, y) => y.bytes - x.bytes).map(songItem),
              })),
        };
      });
    // requestDelete is stable in spirit (setState + module calls); listing rows
    // alone keeps the tree from rebuilding on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

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
              {row.track?.artist ?? 'No longer in the library'} · {size(row.bytes)}
              {row.auto ? ' · automatic' : ' · kept'}
            </span>
          </span>
        ),
        icon: <FileArt art={row.track?.artwork ?? null} glyph={<Music size={13} aria-hidden />} />,
        trailing: (
          <IconButton
            variant="ghost"
            size="sm"
            aria-label={`Delete ${row.track?.title ?? 'this file'} from this device`}
            onClick={() => requestDelete(row.track?.title ?? 'this file', [row])}
          >
            <Trash2 size={14} />
          </IconButton>
        ),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  if (!isTauri() && !fixture) {
    return (
      <Text size="sm" tone="muted">
        A browser tab keeps nothing on the device — everything streams from the server.
      </Text>
    );
  }

  if (rows.length === 0) {
    return (
      <Text size="sm" tone="muted">
        Nothing on this device yet. The cache fills in as you listen, and a song&rsquo;s own menu
        keeps it here for good.
      </Text>
    );
  }

  const pendingBytes = pending?.rows.reduce((n, r) => n + r.bytes, 0) ?? 0;
  const pendingAuto = pending?.rows.filter((r) => r.auto).length ?? 0;

  return (
    <div className="deviceFiles">
      <SegmentedControl
        aria-label="How the files are listed"
        size="sm"
        fullWidth
        value={view}
        options={[
          { value: 'tree', label: 'By artist' },
          { value: 'biggest', label: 'Biggest' },
        ]}
        onValueChange={(next) => setView(next as View)}
      />

      <TreeView
        aria-label={view === 'tree' ? 'Songs on this device, by artist' : 'Largest files on this device'}
        items={view === 'tree' ? tree : biggest}
        className="deviceFiles__tree"
      />

      <Text size="xs" tone="subtle">
        Deleting an automatic download also stops it coming back; the space returns to the budget.
        Kept songs stay gone until you keep them again.
      </Text>

      <AlertDialog
        open={pending !== null}
        onClose={() => setPending(null)}
        tone="danger"
        title={`Delete ${pending?.label ?? ''} from this device?`}
        description={
          pending
            ? `${pending.rows.length} ${pending.rows.length === 1 ? 'song' : 'songs'} · ${size(pendingBytes)} freed.` +
              (pendingAuto > 0 ? ' Automatic downloads will not be re-downloaded.' : '') +
              ' Nothing is removed from the library — only from this phone.'
            : ''
        }
        actionLabel="Delete"
        cancelLabel="Cancel"
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
