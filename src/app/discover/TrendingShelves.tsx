import { Check, Pause, Play, Plus, TrendingUp } from '@glacier/icons';
import { useMemo, useState } from 'react';
import { Shelf, TrackCard } from '../home/homeCards.tsx';
import { ShelfSkeleton } from '../ux/ShelfSkeleton.tsx';
import { usePreview } from '../ux/previewAudio.ts';
import { useDiscoverFeed } from '../home/DiscoverFeed.tsx';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import type { AcquireTarget } from '../../plugins/types.ts';
import type { FriendTrendItem, TrendItem, TrendShelf } from '../api/trending.ts';
import type { Track } from '../core/tauri.ts';

/**
 * Trending, as three shelves that are never one.
 *
 * The server names each shelf and this renders the name as sent: "Charts,
 * filtered for you" is a claim about the world's charts through your taste,
 * "Rising in your scene" a claim about movement near the artists you play,
 * "Friends on this hub" a claim about the people you share a box with. A song
 * can sit on two of them for two different reasons, and folding them would
 * lose the reason. An empty one is absent - not merged, not a note.
 *
 * The first two hold songs not on the box: big cards, the sleeve cropped
 * to a wide face with the name over it, a tap plays the catalogue's thirty
 * seconds (the same one-at-a-time preview the New-for-you modal uses), and
 * Add is its own control in the corner. The friends' shelf holds songs that
 * ARE on the box - by library id, resolved through the same map every home
 * shelf uses - so those are ordinary track cards with who finished them
 * underneath.
 */

/** How many cards a rail shows. */
const RAIL = 6;

export function TrendingShelves({ onPlay }: { onPlay: (track: Track, queue: Track[]) => void }) {
  const { session, trending, home } = useDiscoverFeed();
  if (!session) return null;
  if (trending === undefined) {
    return <ShelfSkeleton title="Charts, filtered for you" kind="mix" count={2} />;
  }
  if (trending === null) return null;
  return (
    <>
      <TrendRail shelf={trending.global} />
      <TrendRail shelf={trending.scene} />
      <FriendsRail shelf={trending.friends} resolve={home.resolve} onPlay={onPlay} />
    </>
  );
}

function TrendRail({ shelf }: { shelf: TrendShelf<TrendItem> }) {
  const items = shelf.items.slice(0, RAIL);
  const { playing, toggle } = usePreview();
  const acquire = useAcquire();
  const downloads = useDownloadsOptional();
  const [taken, setTaken] = useState<Record<string, boolean>>({});

  // The same two-step every other "get this" in the app does: with the
  // importer on a tap IS the download; off, the chooser decides.
  const take = (t: TrendItem) => {
    const target: AcquireTarget = { kind: 'track', title: t.title, artist: t.artist, url: t.url };
    const viaImporter = acquire.handlersFor(target).some((h) => h.pluginId === IMPORTER_PLUGIN_ID);
    if (viaImporter && downloads) void downloads.enqueue(t.url).catch(() => {});
    else acquire.acquire(target);
    setTaken((s) => ({ ...s, [t.extId]: true }));
  };

  return (
    <Shelf title={shelf.label} count={items.length}>
      {items.map((item) => (
        <TrendCard
          key={item.extId}
          item={item}
          playing={playing === item.extId}
          onPreview={() => toggle(item.extId, item.preview)}
          taken={!!taken[item.extId]}
          canTake={acquire.hasAny}
          onTake={() => take(item)}
        />
      ))}
    </Shelf>
  );
}

/**
 * One song moving on a chart. The body is one press (preview); Add is a
 * sibling of it, never nested inside - two verbs, and the smaller one must
 * not ride the tap that plays the clip.
 *
 * Phase 4 hangs the held menu (add, dismiss, "why is this here") off this
 * card: wrap `.trendCard__body` in the house ContextMenu with the hold seam
 * the mix tiles use, exactly as TrackCard wraps in TrackMenu. The card is
 * built so that wrapper is the only change.
 */
function TrendCard({
  item,
  playing,
  onPreview,
  taken,
  canTake,
  onTake,
}: {
  item: TrendItem;
  playing: boolean;
  onPreview: () => void;
  taken: boolean;
  canTake: boolean;
  onTake: () => void;
}) {
  const why = item.anchors[0]?.artist || item.seed;
  const climbed = typeof item.rankDelta === 'number' && item.rankDelta > 0 ? item.rankDelta : null;
  return (
    <div className="trendCard">
      <button
        type="button"
        className="trendCard__body"
        disabled={!item.preview}
        aria-label={
          item.preview
            ? `${playing ? 'Pause' : 'Preview'} ${item.title} by ${item.artist}`
            : `${item.title} by ${item.artist} - no preview`
        }
        onClick={onPreview}
      >
        {item.cover ? (
          <img className="trendCard__art" src={item.cover} alt="" loading="lazy" decoding="async" />
        ) : (
          <span className="trendCard__art trendCard__art--bare" aria-hidden />
        )}
        <span className="trendCard__scrim" aria-hidden />
        {typeof item.rank === 'number' && (
          <span className="trendCard__rank" aria-label={`Number ${item.rank}`}>
            {item.rank}
            {climbed !== null && (
              <span className="trendCard__delta" aria-label={`up ${climbed}`}>
                <TrendingUp size={11} />
                {climbed}
              </span>
            )}
          </span>
        )}
        {item.preview && (
          <span className="trendCard__play" aria-hidden>
            {playing ? <Pause size={18} /> : <Play size={18} />}
          </span>
        )}
        <span className="trendCard__text">
          <span className="trendCard__title">{item.title}</span>
          <span className="trendCard__artist">{item.artist}</span>
          {/* The honest reason it is here, which is the one thing a
              recommendation should always be able to say. */}
          {why && <span className="trendCard__why">because you play {why}</span>}
        </span>
      </button>
      {canTake && (
        <button
          type="button"
          className="trendCard__add"
          data-state={taken ? 'added' : 'idle'}
          aria-label={taken ? `${item.title} asked for` : `Add ${item.title}`}
          disabled={taken}
          onClick={onTake}
        >
          {taken ? <Check size={14} /> : <Plus size={14} />}
        </button>
      )}
    </div>
  );
}

/** What friends on this hub finished: owned songs, so ordinary cards, with
 *  the names under each - "ana, ben" - as the one thing the chart cannot say. */
function FriendsRail({
  shelf,
  resolve,
  onPlay,
}: {
  shelf: TrendShelf<FriendTrendItem>;
  resolve: (ids: number[] | undefined) => Track[];
  onPlay: (track: Track, queue: Track[]) => void;
}) {
  // Resolve each id on its own so the listeners stay beside their song; a
  // song the library has not synced yet simply drops out.
  const rows = useMemo(
    () =>
      shelf.items
        .map((item) => ({ item, track: resolve([item.trackId])[0] ?? null }))
        .filter((r): r is { item: FriendTrendItem; track: Track } => r.track !== null)
        .slice(0, RAIL),
    [shelf.items, resolve],
  );
  const queue = useMemo(() => rows.map((r) => r.track), [rows]);
  return (
    <Shelf title={shelf.label} count={rows.length}>
      {rows.map(({ item, track }) => (
        <TrackCard
          key={item.trackId}
          track={track}
          onOpen={() => onPlay(track, queue)}
          note={item.listeners.join(', ')}
        />
      ))}
    </Shelf>
  );
}
