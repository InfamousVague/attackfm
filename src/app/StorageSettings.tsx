import { Label, SegmentedBar, Text } from '@glacier/react';
import { Disc3, Music, User } from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useLibrary } from './library.tsx';
import { offlineEntries, offlineSpace, onOfflineChange, unpinTrack, type OfflineEntry } from './offline.ts';
import { autoCachedKeys, cacheLimitBytes, onCacheChange } from './autoCache.ts';
import { artSized } from './server.ts';
import { useArtLoad } from './artLoad.ts';
import { isTauri, type Track } from './tauri.ts';

/**
 * Where the phone's space went, file by file.
 *
 * The Offline pane MANAGES the two stores (the cache's budget, the hand-kept
 * list); this one only explains them. One bar splits everything held into
 * cache, kept-by-hand and half-finished downloads; then the same bytes are
 * cut two more ways - by artist, because that is how people remember music,
 * and by size, because that is how they decide what goes. Reading the folder
 * is the only source of truth here, same as everywhere else offline: the
 * disk is the index, and this pane never keeps its own.
 */

function size(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(bytes >= 1e10 ? 0 : 1)} GB`;
  if (bytes >= 1e6) return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** How many rows each list shows. Enough to answer the question; the Offline
 *  pane holds the full management list. */
const ARTISTS_SHOWN = 10;
const FILES_SHOWN = 25;

/** A cover thumb for a breakdown row - its own component because hooks
 *  cannot live inside a map. */
function BreakArt({ artwork, glyph, circle }: { artwork: string | null; glyph: React.ReactNode; circle?: boolean }) {
  const src = artSized(artwork, 160);
  const art = useArtLoad(src, '');
  return (
    <span className="storageBreak__art" data-circle={circle || undefined}>
      {artwork ? <img {...art} src={src ?? undefined} alt="" loading="lazy" /> : glyph}
    </span>
  );
}

export function StorageSettings() {
  const { tracks } = useLibrary();
  const [entries, setEntries] = useState<OfflineEntry[]>([]);
  const [space, setSpace] = useState<{ freeBytes: number | null; heldBytes: number } | null>(null);
  const [owned, setOwned] = useState<Set<string>>(() => autoCachedKeys());

  useEffect(() => {
    const refresh = () => {
      void offlineEntries().then(setEntries);
      void offlineSpace().then(setSpace);
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

  const cut = useMemo(() => {
    let cacheBytes = 0;
    let pinBytes = 0;
    const byArtist = new Map<string, { bytes: number; count: number; cover: string | null }>();
    for (const e of entries) {
      if (owned.has(e.key)) cacheBytes += e.bytes;
      else pinBytes += e.bytes;
      const track: Track | undefined = byPath.get(e.key);
      const artist = track?.artist ?? 'No longer in the library';
      const slot = byArtist.get(artist) ?? { bytes: 0, count: 0, cover: null };
      slot.bytes += e.bytes;
      slot.count += 1;
      if (!slot.cover && track?.artwork) slot.cover = track.artwork;
      byArtist.set(artist, slot);
    }
    const artists = [...byArtist.entries()]
      .map(([artist, v]) => ({ artist, ...v }))
      .sort((a, b) => b.bytes - a.bytes);
    const files = [...entries].sort((a, b) => b.bytes - a.bytes);
    return { cacheBytes, pinBytes, artists, files };
  }, [entries, owned, byPath]);

  if (!isTauri()) {
    return (
      <div className="prefsBody">
        <Text size="sm" tone="muted">
          A browser tab keeps nothing on the device — everything streams from the server.
        </Text>
      </div>
    );
  }

  const listed = cut.cacheBytes + cut.pinBytes;
  // The folder can hold more than the listings say: a download's .part file
  // is deliberately not an entry, but its bytes are real.
  const debris = Math.max(0, (space?.heldBytes ?? listed) - listed);
  const total = listed + debris;
  const artistMax = cut.artists[0]?.bytes ?? 0;

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Label>Space used</Label>
        <div className="storageBreak__totals">
          <span className="storageBreak__big">{size(total)}</span>
          <Text size="sm" tone="muted">
            {entries.length.toLocaleString()} {entries.length === 1 ? 'song' : 'songs'} on this device
            {space?.freeBytes != null ? ` · ${size(space.freeBytes)} free` : ''}
          </Text>
        </div>
        {total > 0 && (
          <>
            <SegmentedBar
              size="md"
              rounded
              data={[
                { value: cut.cacheBytes, tone: 'accent', label: 'Downloaded automatically' },
                { value: cut.pinBytes, tone: 'success', label: 'Kept by hand' },
                { value: debris, tone: 'neutral', label: 'Still downloading' },
              ]}
              aria-label="What is using the space"
            />
            <div className="storageBreak__legend">
              <span className="storageBreak__key" data-tone="accent">
                {/* The limit is set in binary GB (15 * 1024³); saying "of 16 GB"
                    here while Offline says "15 GB" would read as two settings. */}
                Automatic · {size(cut.cacheBytes)} of {`${Math.round(cacheLimitBytes() / 1024 ** 3)} GB`}
              </span>
              <span className="storageBreak__key" data-tone="success">
                Kept by hand · {size(cut.pinBytes)}
              </span>
              {debris > 0 && (
                <span className="storageBreak__key" data-tone="neutral">
                  Still downloading · {size(debris)}
                </span>
              )}
            </div>
          </>
        )}
        {total === 0 && (
          <Text size="sm" tone="muted">
            Nothing stored yet. The cache fills in as you listen, and a song&rsquo;s own menu keeps it
            here for good.
          </Text>
        )}
      </div>

      {cut.artists.length > 0 && (
        <div className="prefsSection">
          <Label>By artist</Label>
          <ol className="storageBreak__rows">
            {cut.artists.slice(0, ARTISTS_SHOWN).map((row) => (
              <li key={row.artist} className="storageBreak__row">
                <BreakArt artwork={row.cover} circle glyph={<User size={14} aria-hidden />} />
                <span className="storageBreak__body">
                  <span className="storageBreak__name">{row.artist}</span>
                  <span className="storageBreak__rail" aria-hidden>
                    <span
                      className="storageBreak__fill"
                      style={{ inlineSize: artistMax > 0 ? `${(row.bytes / artistMax) * 100}%` : '0%' }}
                    />
                  </span>
                </span>
                <span className="storageBreak__meta">
                  {row.count} · {size(row.bytes)}
                </span>
              </li>
            ))}
          </ol>
          {cut.artists.length > ARTISTS_SHOWN && (
            <Text size="xs" tone="subtle">
              …and {cut.artists.length - ARTISTS_SHOWN} more artists.
            </Text>
          )}
        </div>
      )}

      {cut.files.length > 0 && (
        <div className="prefsSection">
          <Label>Largest files</Label>
          <ol className="storageBreak__rows">
            {cut.files.slice(0, FILES_SHOWN).map((e) => {
              const track = byPath.get(e.key);
              const cached = owned.has(e.key);
              return (
                <li key={e.key} className="storageBreak__row">
                  <BreakArt
                    artwork={track?.artwork ?? null}
                    glyph={track ? <Music size={14} aria-hidden /> : <Disc3 size={14} aria-hidden />}
                  />
                  <span className="storageBreak__body">
                    <span className="storageBreak__name">{track?.title ?? 'No longer in the library'}</span>
                    <span className="storageBreak__sub">
                      {track?.artist ?? e.key} · {cached ? 'automatic' : 'kept by hand'}
                    </span>
                  </span>
                  <span className="storageBreak__meta">
                    {size(e.bytes)}
                    {/* Only the hand-kept can be let go from here: deleting a
                        cached file is a promise the next sweep would quietly
                        break by downloading it again. The cache's own space
                        is given back by lowering its limit in Offline. */}
                    {!cached && (
                      <button
                        type="button"
                        className="storageBreak__remove"
                        aria-label={`Remove ${track?.title ?? 'this download'}`}
                        onClick={() => void unpinTrack(e.key)}
                      >
                        Remove
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
          {cut.files.length > FILES_SHOWN && (
            <Text size="xs" tone="subtle">
              …and {cut.files.length - FILES_SHOWN} more. The Offline pane holds the full list.
            </Text>
          )}
        </div>
      )}
    </div>
  );
}
