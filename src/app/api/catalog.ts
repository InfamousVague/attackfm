import { request, type ServerSession } from './http.ts';

/** One external catalogue hit (Spotify/Deezer), from `GET /api/search`. A
 *  track or album carries an importable `url`; an artist is a name to search
 *  deeper. */
export interface SearchResult {
  id: string;
  kind: 'track' | 'artist' | 'album';
  title: string;
  subtitle: string;
  cover: string | null;
  /** The link to hand the importer (present for tracks and albums). */
  url: string;
  source: string;
  /**
   * Whether `url` is something the importer can take as PRIMARY input, which
   * today means a Spotify link. A Deezer album is worth showing and cannot be
   * pulled, so the row renders either way and only its Add control reads this.
   */
  importable: boolean;
}

/**
 * Playlists to pull whole, by name - or what is popular right now when the
 * box is empty.
 *
 * A `kind` of its own because a playlist is not a search result you play: it
 * is a thousand songs the importer takes as one job, which is why it lives
 * behind its own endpoint and its own surface rather than mixing into the
 * catalogue rows above.
 */
export interface PlaylistResult extends Omit<SearchResult, 'kind'> {
  kind: 'playlist';
}

export async function searchPlaylists(
  session: ServerSession,
  query: string,
  signal?: AbortSignal,
): Promise<PlaylistResult[]> {
  const reply = await request<{ results: PlaylistResult[] }>(
    session.url,
    `/api/search/playlists?q=${encodeURIComponent(query)}`,
    { token: session.token, signal },
  );
  return reply.results ?? [];
}

/** Search Spotify and other public sources for new artists and songs. */
export async function searchCatalog(
  session: ServerSession,
  query: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const reply = await request<{ results: SearchResult[] }>(
    session.url,
    `/api/search?q=${encodeURIComponent(query)}`,
    { token: session.token, signal },
  );
  return reply.results;
}

/**
 * One thing the user opened from search before, as the server remembers it.
 *
 * Deliberately a flat, self-describing row rather than a reference: a recent
 * has to render as a card the moment the page opens, before the library has
 * synced and whether or not the thing still exists. `key` is what makes it
 * unique within its kind - a track path, an artist name, a playlist id - and
 * is what a tap resolves against when the library does have it.
 */
export interface Recent {
  kind: 'track' | 'artist' | 'album' | 'playlist' | 'genre' | 'catalog';
  key: string;
  title: string;
  subtitle: string;
  cover: string | null;
  url: string;
  /** When it was last opened, epoch milliseconds. */
  at: number;
}

/** What this account has opened from search lately, newest first. */
export async function fetchRecents(
  session: ServerSession,
  signal?: AbortSignal,
): Promise<Recent[]> {
  const reply = await request<{ recents: Recent[] }>(session.url, '/api/recents', {
    token: session.token,
    signal,
  });
  return reply.recents;
}

/** Remember one - or bump it to the front, if it is already there. */
export async function touchRecent(
  session: ServerSession,
  recent: Omit<Recent, 'at'>,
): Promise<void> {
  await request(session.url, '/api/recents', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify(recent),
  });
}

/** Forget one. */
export async function removeRecent(
  session: ServerSession,
  kind: string,
  key: string,
): Promise<void> {
  await request(session.url, '/api/recents/remove', {
    method: 'POST',
    token: session.token,
    body: JSON.stringify({ kind, key }),
  });
}

/** Forget all of them. */
export async function clearRecents(session: ServerSession): Promise<void> {
  await request(session.url, '/api/recents/clear', {
    method: 'POST',
    token: session.token,
  });
}

/** One release on an artist's page: an album, EP, single or compilation. Its
 *  `url` is an album link the importer takes whole. */
/**
 * A record you own PART of, and what is missing from it.
 *
 * The server has answered this since the gaps work landed - which of an
 * artist's albums you hold some of, the catalogue's tracklist for each, and
 * the difference - and no client had ever asked. It is the honest shape for
 * "most of this album is missing": positions and titles, so the gap can be
 * shown as the songs it actually is rather than a count.
 */
export interface MissingTrack {
  position: number;
  title: string;
  /** The catalogue's own link, which the importer may or may not take. */
  url: string;
}

export interface AlbumGap {
  album: string;
  artist: string;
  cover: string | null;
  owned: number;
  total: number;
  missing: MissingTrack[];
}

/**
 * Which of an artist's records you own part of, nearly-complete first.
 *
 * Throws ServerError(404) on a server from before this shipped; the caller
 * says so plainly rather than showing an empty shelf that reads as "you have
 * everything".
 */
export async function fetchAlbumGaps(
  session: ServerSession,
  artist: string,
  signal?: AbortSignal,
): Promise<AlbumGap[]> {
  const reply = await request<{ albums: AlbumGap[] }>(
    session.url,
    `/api/albums/gaps?artist=${encodeURIComponent(artist)}`,
    { token: session.token, signal },
  );
  return reply.albums ?? [];
}

/** One song on a record, as the catalogue lists it. Distinct from
 *  CatalogTrack below, which is an artist's top songs across everything. */
export interface AlbumTrack {
  position: number;
  /** Which disc of a set; absent from servers older than the field, so
   *  read it as 1. Positions restart per disc on a set. */
  disc?: number;
  title: string;
  /** The link an import takes. Empty when the catalogue gave none. */
  url: string;
  /** Whether this library already holds it. */
  owned: boolean;
}

/**
 * The whole of one record, each song marked owned or not.
 *
 * A catalogue's album entry carries no songs - only a link to them - so this
 * is a second call per record and cannot be folded into the artist reply. An
 * empty `tracks` is a valid answer (catalogue unreachable, or it does not list
 * this album) and means "show what you have", not "this record is complete".
 */
export async function fetchAlbumTracks(
  session: ServerSession,
  artist: string,
  album: string,
  signal?: AbortSignal,
): Promise<AlbumTrack[]> {
  const reply = await request<{ tracks: AlbumTrack[] }>(
    session.url,
    `/api/album/tracks?artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(album)}`,
    { token: session.token, signal },
  );
  return reply.tracks ?? [];
}

export interface CatalogRelease {
  id: string;
  title: string;
  cover: string | null;
  year: string | null;
  trackCount: number | null;
  kind: string;
  url: string;
  /** As `SearchResult.importable`. A whole discography arrives from Deezer, so
   *  this is usually false - which is a fact about the Add button, not about
   *  whether the record belongs on the page. */
  importable: boolean;
}

/** One of an artist's best-known tracks, importable on its own. */
export interface CatalogTrack {
  id: string;
  title: string;
  cover: string | null;
  url: string;
  /** Seconds. */
  duration: number | null;
  /** As `SearchResult.importable`. */
  importable: boolean;
}

/** An artist's profile and discography, from `GET /api/artist`. */
export interface CatalogArtist {
  id: string;
  name: string;
  picture: string | null;
  url: string;
  source: string;
  /** Follower count, as the catalogue reports it. */
  fans: number | null;
  albumCount: number | null;
  albums: CatalogRelease[];
  singles: CatalogRelease[];
  top: CatalogTrack[];
  related: { id: string; name: string; picture: string | null }[];
}

/**
 * One catalogue artist, opened from a search row. The name rides along because
 * a Spotify row carries no Deezer id and the server resolves it by name.
 */
export async function fetchCatalogArtist(
  session: ServerSession,
  id: string,
  name: string,
  signal?: AbortSignal,
): Promise<CatalogArtist> {
  const reply = await request<{ artist: CatalogArtist }>(
    session.url,
    `/api/artist?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`,
    { token: session.token, signal },
  );
  return reply.artist;
}
