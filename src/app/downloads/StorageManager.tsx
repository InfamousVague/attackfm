import { Button, Checkbox, Heading, Input, Text, VirtualList } from '@glacier/react';
import { ArrowLeft, Search, Trash2, TriangleAlert } from '@glacier/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  fetchTrash,
  loadCachedIndex,
  purgeTrash,
  removeTracks,
  syncLibrary,
  type RemoteTrack,
  type ServerSession,
  type TrashState,
} from '../server.ts';
import { loadHoldings, trackKey } from '../servers/mirrors.ts';

/**
 * Freeing space on one server, song by song.
 *
 * The honest version of "delete", which on a mirrored library is two questions,
 * not one. First: is this song anywhere else? Deleting the last copy of
 * something is a different act from deleting a redundant copy, and the list
 * says which is which before anything is chosen. Second: does removing it
 * actually give the disk back? It does not - removal quarantines, and only
 * emptying the trash reclaims - so both steps are here, in that order, with the
 * irreversible one behind its own confirmation.
 *
 * Sorted biggest-first by default, because someone who opened this page wants
 * gigabytes back and forty lossless albums are the answer, not four hundred
 * singles.
 */

function size(bytes: number): string {
  const g = bytes / 1024 ** 3;
  if (g >= 1) return `${g.toFixed(1)} GB`;
  const m = bytes / 1024 ** 2;
  if (m >= 1) return `${Math.round(m)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

type Sort = 'largest' | 'oldest' | 'artist';

const ROW_HEIGHT = 60;

export function StorageManager({
  target,
  name,
  peerUrls,
  onBack,
}: {
  /** The server being cleaned - session server or an admin mirror. */
  target: ServerSession;
  name: string;
  /** Every OTHER server this device knows, for the only-copy check. */
  peerUrls: string[];
  onBack: () => void;
}) {
  const [tracks, setTracks] = useState<RemoteTrack[]>(() => loadCachedIndex(target.url).tracks);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('largest');
  const [trash, setTrash] = useState<TrashState | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [confirmPurge, setConfirmPurge] = useState(false);

  const reload = useCallback(async () => {
    try {
      const { tracks: fresh } = await syncLibrary(target);
      setTracks(fresh);
    } catch {
      // The cached list is still the right thing to show.
    }
    try {
      setTrash(await fetchTrash(target));
    } catch {
      setTrash(null);
    }
  }, [target]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * How many known servers hold each song.
   *
   * Only servers this device can actually see count, which is the honest
   * limit: a copy on a box that was never linked here is a copy nobody can
   * promise. So "only copy" means "the only one I know about" - stated that
   * way in the UI rather than as a guarantee.
   */
  const copies = useMemo(() => {
    const seen = new Map<string, number>();
    for (const url of new Set(peerUrls)) {
      if (url === target.url) continue;
      for (const key of loadHoldings(url).keys()) seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return seen;
  }, [peerUrls, target.url]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? tracks.filter(
          (t) =>
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q) ||
            t.album.toLowerCase().includes(q),
        )
      : tracks;
    const sorted = [...filtered];
    if (sort === 'largest') sorted.sort((a, b) => b.sizeBytes - a.sizeBytes);
    else if (sort === 'oldest') sorted.sort((a, b) => a.addedAt - b.addedAt);
    else sorted.sort((a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title));
    return sorted;
  }, [tracks, query, sort]);

  const pickedBytes = useMemo(() => {
    let total = 0;
    for (const t of tracks) if (picked.has(t.id)) total += t.sizeBytes;
    return total;
  }, [tracks, picked]);

  const pickedOnlyCopies = useMemo(() => {
    let n = 0;
    for (const t of tracks) {
      if (picked.has(t.id) && !copies.has(trackKey(t.artist, t.title))) n += 1;
    }
    return n;
  }, [tracks, picked, copies]);

  const toggle = (id: number) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const remove = async () => {
    if (picked.size === 0) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await removeTracks(target, [...picked]);
      setPicked(new Set());
      setNote(
        `Moved ${result.removed.toLocaleString()} ${result.removed === 1 ? 'song' : 'songs'} to the trash. Empty it below to get the ${size(result.bytes)} back.`,
      );
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const empty = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await purgeTrash(target);
      setNote(`Freed ${size(result.bytes)}.`);
      setConfirmPurge(false);
      await reload();
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  const total = useMemo(() => tracks.reduce((n, t) => n + t.sizeBytes, 0), [tracks]);

  return (
    <div className="storage">
      <header className="storage__head">
        <Button variant="ghost" onClick={onBack} aria-label="Back to servers">
          <ArrowLeft size={16} />
        </Button>
        <div>
          <Heading level={2} noMargin>
            Free up space
          </Heading>
          <Text size="sm" tone="muted">
            {name} · {tracks.length.toLocaleString()} songs · {size(total)}
          </Text>
        </div>
      </header>

      <div className="storage__controls">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a song, artist or album"
          leadingIcon={<Search size={16} />}
        />
        <div className="storage__sorts" role="group" aria-label="Sort">
          {(
            [
              ['largest', 'Largest'],
              ['oldest', 'Oldest'],
              ['artist', 'Artist'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className="storage__sort"
              data-active={sort === key || undefined}
              onClick={() => setSort(key)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="storage__bulk">
        <Checkbox
          checked={rows.length > 0 && rows.every((t) => picked.has(t.id))}
          indeterminate={rows.some((t) => picked.has(t.id)) && !rows.every((t) => picked.has(t.id))}
          onCheckedChange={(on) => {
            setPicked((prev) => {
              const next = new Set(prev);
              for (const t of rows) {
                if (on) next.add(t.id);
                else next.delete(t.id);
              }
              return next;
            });
          }}
          label={query ? `Select these ${rows.length.toLocaleString()}` : 'Select all'}
        />
        {picked.size > 0 && (
          <Text size="sm" tone="muted">
            {picked.size.toLocaleString()} selected · {size(pickedBytes)}
          </Text>
        )}
      </div>

      <VirtualList
        className="storage__list"
        count={rows.length}
        itemSize={ROW_HEIGHT}
        getKey={(i) => rows[i]?.id ?? i}
        emptyLabel="Nothing matches that."
        renderItem={(i) => {
          const t = rows[i];
          if (!t) return null;
          const elsewhere = copies.get(trackKey(t.artist, t.title)) ?? 0;
          return (
            <label className="storageRow" data-picked={picked.has(t.id) || undefined}>
              <Checkbox checked={picked.has(t.id)} onCheckedChange={() => toggle(t.id)} />
              <span className="storageRow__text">
                <span className="storageRow__title">{t.title}</span>
                <span className="storageRow__sub">
                  {t.artist}
                  {elsewhere > 0 ? (
                    <span className="storageRow__safe"> · also on {elsewhere} other</span>
                  ) : (
                    <span className="storageRow__only"> · only copy</span>
                  )}
                </span>
              </span>
              <span className="storageRow__size">{size(t.sizeBytes)}</span>
            </label>
          );
        }}
      />

      {note && (
        <Text size="sm" tone="muted" className="storage__note">
          {note}
        </Text>
      )}

      <footer className="storage__foot">
        {pickedOnlyCopies > 0 && (
          <span className="storage__warn">
            <TriangleAlert size={14} />
            {pickedOnlyCopies.toLocaleString()} of these are the only copy I know of
          </span>
        )}
        <Button variant="danger" disabled={picked.size === 0 || busy} onClick={() => void remove()}>
          <Trash2 size={16} />
          {picked.size > 0 ? `Remove ${picked.size.toLocaleString()} · ${size(pickedBytes)}` : 'Remove'}
        </Button>
      </footer>

      {trash && trash.files > 0 && (
        <section className="storage__trash">
          <div>
            <Text>In the trash</Text>
            <Text size="sm" tone="muted">
              {trash.files.toLocaleString()} files · {size(trash.bytes)} recoverable until emptied
            </Text>
          </div>
          {confirmPurge ? (
            <div className="storage__confirm">
              <Text size="sm" tone="danger">
                Deletes {trash.files.toLocaleString()} files for good.
              </Text>
              <Button variant="ghost" onClick={() => setConfirmPurge(false)} disabled={busy}>
                Cancel
              </Button>
              <Button variant="danger" onClick={() => void empty()} disabled={busy}>
                Empty trash
              </Button>
            </div>
          ) : (
            <Button variant="outline" onClick={() => setConfirmPurge(true)} disabled={busy}>
              Empty trash · {size(trash.bytes)}
            </Button>
          )}
        </section>
      )}
    </div>
  );
}
