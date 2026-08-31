/**
 * The artist page's acquire flow: one `adding` state map shared by the
 * discography cards, the Popular rows and the album-gap rows (keys 'cat:id',
 * track ids, 'gap:album:pos'), and the three add paths that all walk the same
 * two steps - resolve the Spotify twin of a Deezer link, then enqueue it.
 * Split out of ArtistPage.tsx verbatim; the hook is called once by the page
 * and its pieces flow down to the sections as props.
 */
import { useState } from 'react';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../../plugins/runtime.tsx';
import { useDownloadsOptional } from '../../plugins/importsBridge.ts';
import type { AcquireTarget } from '../../plugins/types.ts';
import { PROBE_URL, importable, resolveImportable } from '../search/resolveImport.ts';
import { addPendingLike } from '../server.ts';
import type { AlbumGap, CatalogTrack, ServerSession } from '../server.ts';
import type { DiscRow } from './artistData.ts';

/** What a tapped row is doing, keyed per row. */
export type AddingState = Record<string, 'finding' | 'added' | 'missing'>;

export function useArtistAcquire(artist: string, session: ServerSession | null) {
  const acquire = useAcquire();
  const downloads = useDownloadsOptional();
  // What a tapped record is doing. A record you do not own carries a Deezer
  // link the importer will not take, so the tap searches for its Spotify
  // twin first - which takes a beat and can come back empty, and both of
  // those have to be visible on the row that was tapped.
  const [adding, setAdding] = useState<AddingState>({});
  // Catalogue rows loved from the artist page: the download runs (addSong)
  // AND a pending like is written, so the song walks into Liked when it
  // lands - the same promise a Discover heart makes. Track ids of the loved
  // rows so the heart reads filled at once.
  const [loved, setLoved] = useState<Set<string>>(new Set());

  /**
   * Pull a record you do not own.
   *
   * The link the discography carries is Deezer's, which the importer refuses as
   * primary input, so this finds the same record on Spotify by name first and
   * hands the importer that. The row says what is happening throughout, because
   * a search over the network is long enough that a silent button reads as a
   * broken one.
   */
  const addRecord = async (row: DiscRow) => {
    if (!session || adding[row.key]) return;
    setAdding((prev) => ({ ...prev, [row.key]: 'finding' }));

    // Already importable (a Spotify link, one day) - no need to go looking.
    if (row.release && importable(row.release)) {
      take('album', row.title, row.release.url);
      setAdding((prev) => ({ ...prev, [row.key]: 'added' }));
      return;
    }

    let found = null;
    try {
      found = await resolveImportable(session, 'album', artist, row.title);
    } catch {
      // Offline or the catalogue refused; indistinguishable from "not there"
      // as far as the row is concerned.
    }
    if (!found) {
      setAdding((prev) => ({ ...prev, [row.key]: 'missing' }));
      // Long enough to read, then the row goes back to being a live offer so
      // the tap doubles as the retry.
      window.setTimeout(
        () =>
          setAdding((prev) => {
            const next = { ...prev };
            delete next[row.key];
            return next;
          }),
        4000,
      );
      return;
    }
    take('album', found.title, found.url);
    setAdding((prev) => ({ ...prev, [row.key]: 'added' }));
  };

  /**
   * Pull one of the artist's best-known songs. The same two steps a record
   * takes - find the Spotify twin of a Deezer link, then hand it over - kept
   * separate only because a song's key and copy differ from a record's.
   */
  const addSong = async (t: CatalogTrack) => {
    if (!session || adding[t.id]) return;
    setAdding((prev) => ({ ...prev, [t.id]: 'finding' }));
    if (importable(t)) {
      take('track', t.title, t.url);
      setAdding((prev) => ({ ...prev, [t.id]: 'added' }));
      return;
    }
    let found = null;
    try {
      found = await resolveImportable(session, 'track', artist, t.title);
    } catch {
      // Same outcome as not being there.
    }
    if (!found) {
      setAdding((prev) => ({ ...prev, [t.id]: 'missing' }));
      window.setTimeout(
        () =>
          setAdding((prev) => {
            const next = { ...prev };
            delete next[t.id];
            return next;
          }),
        4000,
      );
      return;
    }
    take('track', found.title, found.url);
    setAdding((prev) => ({ ...prev, [t.id]: 'added' }));
  };

  /**
   * Love a catalogue song: pull it down like Add does, and promise the like
   * so it lands in Liked. No now-playing hijack - a heart is not a listen.
   */
  const loveSong = (t: CatalogTrack) => {
    if (!session) return;
    setLoved((prev) => new Set(prev).add(t.id));
    if (!adding[t.id]) void addSong(t);
    void addPendingLike(session, artist, t.title).catch(() => {});
  };

  /**
   * Pull one song that is missing from a record you already own part of.
   *
   * The gap rows carry the catalogue's own link, which the importer usually
   * will not take (a whole tracklist arrives from Deezer), so this walks the
   * same two steps everything else here does: try the link, and fall back to
   * resolving the Spotify twin by name.
   */
  const addMissing = async (gap: AlbumGap, row: { position: number; title: string; url: string }) => {
    const key = `gap:${gap.album}:${row.position}`;
    if (!session || adding[key]) return;
    setAdding((prev) => ({ ...prev, [key]: 'finding' }));
    if (importable({ url: row.url } as CatalogTrack)) {
      take('track', row.title, row.url);
      setAdding((prev) => ({ ...prev, [key]: 'added' }));
      return;
    }
    let found = null;
    try {
      found = await resolveImportable(session, 'track', artist, row.title);
    } catch {
      // Same outcome as not being there.
    }
    if (!found) {
      setAdding((prev) => ({ ...prev, [key]: 'missing' }));
      window.setTimeout(
        () =>
          setAdding((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          }),
        4000,
      );
      return;
    }
    take('track', found.title, found.url);
    setAdding((prev) => ({ ...prev, [key]: 'added' }));
  };

  /**
   * Hand a resolved record to whatever will fetch it.
   *
   * Straight down the importer's own queue when it is running - "start the
   * import" is the whole point of having looked the record up, and routing
   * through the generic chooser would put a dialog between the tap and the
   * download. With the importer off, the chooser is right: something else
   * (Buy) may still be able to get it.
   */
  const take = (kind: 'album' | 'track', title: string, url: string) => {
    const target: AcquireTarget = { kind, title, artist, url };
    const viaImporter = acquire.handlersFor(target).some((h) => h.pluginId === IMPORTER_PLUGIN_ID);
    if (viaImporter && downloads) void downloads.enqueue(url).catch(() => {});
    else acquire.acquire(target);
  };

  // "Would anything take an album link, if I found one?" - probed with a
  // Spotify-shaped URL because a downloader's canHandle tests for one, so
  // asking with the empty string would always answer no.
  const canAddAlbum = (title: string) =>
    session !== null && acquire.hasHandlers({ kind: 'album', title, artist, url: PROBE_URL });

  return { adding, addRecord, addSong, addMissing, loveSong, loved, canAddAlbum, downloads };
}
