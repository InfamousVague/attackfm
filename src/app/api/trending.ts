import { ServerError, request, type ServerSession } from './http.ts';

/**
 * Trending, three ways, never blended.
 *
 * The server keeps three separate answers to "what is moving right now" and
 * the page shows them as three separately labelled shelves - by request. They
 * are different claims and a listener should be able to tell which one a song
 * is making:
 *
 *  - `global`: the charts, filtered through this listener's taste. Songs that
 *    are big everywhere AND near what actually gets played here.
 *  - `scene`: rising in this listener's own scene - anchored to artists they
 *    play, compared against the last chart snapshot so "rising" is a real
 *    delta and not a synonym for "popular".
 *  - `friends`: what the other people on this hub have been finishing. Owned
 *    songs, by library id, so they resolve like any home-feed shelf.
 *
 * Each shelf carries its own `label`, and the page renders the label exactly
 * as sent: the server names the claim, the client does not rename it. An
 * empty `items` means the shelf is absent - hidden, never folded into a
 * neighbour.
 */

/** Why a candidate is near this listener: an artist they play, and how. */
export interface TrendAnchor {
  artist: string;
  /** 'plays' | 'likes' | 'similar' and whatever else the server learns. */
  kind: string;
  /** 0..1 */
  strength: number;
}

/** One song from the catalogue - not on the box - moving on a chart. */
export interface TrendItem {
  /** The catalogue's own id, e.g. `deezer:track:123`. */
  extId: string;
  title: string;
  artist: string;
  cover: string;
  /** The link the importer takes. */
  url: string;
  /** A thirty second clip, or '' when the catalogue offered none. */
  preview: string;
  /** The artist of theirs this hangs off. */
  seed: string;
  /** Which bench dealt it: 'trending' | 'fresh' | 'taste'. */
  lane: string;
  bpm?: number | null;
  score: number;
  /** Chart position, when the shelf is a chart. */
  rank?: number | null;
  /** Places climbed since the last snapshot; negative is falling. */
  rankDelta?: number | null;
  anchors: TrendAnchor[];
  measured: { tempo: boolean; lyrics: boolean; texture: boolean };
  /** Release date, when known. */
  released?: string | null;
}

/** A song a friend on this hub finished - a library id, resolved client-side. */
export interface FriendTrendItem {
  trackId: number;
  /** Who finished it, by name. */
  listeners: string[];
  completions: number;
  lastAt: number;
}

export interface TrendShelf<T> {
  id: string;
  /** Rendered verbatim. */
  label: string;
  items: T[];
}

export interface TrendingFeed {
  global: TrendShelf<TrendItem>;
  scene: TrendShelf<TrendItem>;
  friends: TrendShelf<FriendTrendItem> & { names: string[] };
}

function shelf<T>(raw: unknown, fallbackId: string, fallbackLabel: string): TrendShelf<T> {
  const r = (raw ?? {}) as Partial<TrendShelf<T>>;
  return {
    id: typeof r.id === 'string' ? r.id : fallbackId,
    label: typeof r.label === 'string' ? r.label : fallbackLabel,
    items: Array.isArray(r.items) ? r.items : [],
  };
}

/**
 * The three shelves, or null when this hub has no trending route yet.
 *
 * Null rather than three empty shelves so the page can tell "nothing is
 * moving" from "this server predates the feature" - both hide the shelves,
 * and neither is worth a message. Any other failure throws, like every feed.
 */
export async function fetchTrending(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<TrendingFeed | null> {
  try {
    const raw = await request<Partial<TrendingFeed>>(session.url, '/api/trending', {
      token: session.token,
      signal,
    });
    const friends = shelf<FriendTrendItem>(raw.friends, 'trend-friends', 'Friends on this hub');
    const names = Array.isArray((raw.friends as { names?: unknown } | undefined)?.names)
      ? ((raw.friends as { names: unknown[] }).names.filter((n): n is string => typeof n === 'string'))
      : [];
    return {
      global: shelf<TrendItem>(raw.global, 'trend-global', 'Charts, filtered for you'),
      scene: shelf<TrendItem>(raw.scene, 'trend-scene', 'Rising in your scene'),
      friends: { ...friends, names },
    };
  } catch (e) {
    if (e instanceof ServerError && e.status === 404) return null;
    throw e;
  }
}
