/**
 * The client half of the streaming server.
 *
 * The design goal here was that the *player* should not learn anything. It
 * already plays whatever URL it is handed through an `<audio>` element with
 * `crossOrigin="anonymous"`, and it already reads levels off a CORS-clean
 * remote source - the demo stream it opens with is exactly that. So a remote
 * track is modelled as a track whose `path` happens to be an `afm://` URI:
 * every surface that keys on path (favourites, the table, the search, the
 * queue) keeps working untouched, and the one place that turns a path into
 * something playable - `loadAudioUrl` - learns the new scheme.
 *
 * Two credentials come back from a sign-in and they are used differently:
 * the session token rides an Authorization header on the JSON calls, and the
 * stream token goes in the query string of media URLs, because `<audio src>`
 * and `<img src>` cannot carry headers. See the server's `auth.rs` for why
 * that is a separate, expiring, read-only capability rather than the session
 * token in a less careful place.
 *
 * The implementation now lives in src/app/api/ (one file per domain:
 * http, auth, library, libraryCache, listening, refetch, admin, feed, dj,
 * friends, jams, curator, push, mirror, catalog, playlists, radio); this
 * file re-exports the whole surface so existing imports stay put.
 */

export { ServerError, normalizeServerUrl } from './api/http.ts';
export type { ServerSession, ServerInfo } from './api/http.ts';
export * from './api/auth.ts';
export * from './api/library.ts';
export * from './api/libraryCache.ts';
export * from './api/listening.ts';
export * from './api/refetch.ts';
export * from './api/stems.ts';
export * from './api/admin.ts';
export * from './api/feed.ts';
export * from './api/dj.ts';
export * from './api/friends.ts';
export * from './api/jams.ts';
export * from './api/curator.ts';
export * from './api/push.ts';
export * from './api/mirror.ts';
export * from './api/catalog.ts';
export * from './api/playlists.ts';
export * from './api/radio.ts';
