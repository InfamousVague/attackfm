import { ServerError, request, type ServerSession } from './http.ts';

/**
 * New-music playlists: the discovery pool, grouped and named by the model.
 *
 * These are songs the listener does NOT own. The server harvests them from
 * artists near what is actually played, measures the ones it can (a tempo off
 * the preview, the words read into a vector), scores them, and then asks the
 * model to sort the best sixty into three to five themed sets with names and
 * one-line blurbs.
 *
 * The endpoint has existed since August and nothing ever called it - the commit
 * that added it touched only the server. So the pool it draws on, several
 * hundred songs deep, had no surface in the app at all: Music Date shows only
 * what the collector has already BOUGHT, which is a different and much smaller
 * set. This is the first screen that shows the rest of it.
 */

/** One song the listener does not own yet. */
export interface NewMusicTrack {
  /** The catalogue's own id, e.g. `deezer:track:123`. Not a library id. */
  id: string;
  title: string;
  artist: string;
  /** Remote cover art from the catalogue, not the user's own library art. */
  cover: string;
  /** The link the importer takes, when the listener wants it for keeps. */
  url: string;
  /** A thirty second clip, when the catalogue offered one. */
  preview: string;
  /** The artist of theirs this hangs off - the honest "why is this here". */
  seed: string;
  /** Measured off the preview, when there was one to measure. */
  bpm: number | null;
  /** Whether its words were really read, so the UI can say why without
   *  overclaiming. */
  lyricsRead: boolean;
  score: number;
}

export interface NewMusicList {
  id: string;
  title: string;
  /** One warm line about the set. May be empty. */
  blurb: string;
  items: NewMusicTrack[];
}

/**
 * The lists, or an empty array.
 *
 * Empty is the ordinary answer in three different situations and the caller
 * cannot tell them apart, deliberately: no model is configured, the pool is too
 * thin to group yet, or the first build is still running in the background. All
 * three mean "nothing to show right now", and the shelf simply does not appear.
 *
 * A server too old to have the route answers 404, which is also empty rather
 * than an error - the app updates over the air and the hub does not, so an
 * un-rebuilt server is an ordinary state and not a fault to shout about.
 */
export async function fetchNewMusic(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<NewMusicList[]> {
  try {
    const reply = await request<{ playlists?: NewMusicList[] }>(
      session.url,
      '/api/new-music',
      { token: session.token, signal },
    );
    // Preview paths arrive relative and signed (see api/trending.ts): made
    // absolute here so a row can play them inside the tap.
    return (reply.playlists ?? [])
      .filter((l) => l.items?.length > 0)
      .map((l) => ({
        ...l,
        items: l.items.map((t) =>
          t.preview && t.preview.startsWith('/') ? { ...t, preview: `${session.url}${t.preview}` } : t,
        ),
      }));
  } catch (e) {
    if (e instanceof ServerError && e.status === 404) return [];
    throw e;
  }
}
