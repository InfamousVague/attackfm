import { Button, Field, Input, Label, Pill, Text } from '@glacier/react';
import { useCallback, useEffect, useState } from 'react';
import { isTauri } from '../../app/tauri.ts';
import { useDownloads } from './downloadsContext.ts';
import {
  registerPendingSync,
  spotifyConnect,
  spotifyDisconnect,
  spotifyLibrary,
  spotifyStatus,
  type SpotifyAlbum,
  type SpotifyLibrary,
  type SpotifyPlaylist,
  type SpotifyStatus,
} from './spotifyAccount.ts';

/**
 * The Spotify tab: connect an account, browse its saved albums and
 * playlists, and feed them to the import queue. The heavy lifting all lives
 * elsewhere - OAuth and the Web API in the Rust account layer, the actual
 * downloading in the existing SpotiFLAC pipeline - so this is glue: list
 * what the account has, say what has already been synced, and enqueue the
 * rest on request.
 */
export function SpotifyAccountSettings() {
  const { enqueue, jobs } = useDownloads();
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [clientId, setClientId] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [library, setLibrary] = useState<SpotifyLibrary | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refreshLibrary = useCallback(async () => {
    setLoadingLibrary(true);
    setError(null);
    try {
      setLibrary(await spotifyLibrary());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingLibrary(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void (async () => {
      try {
        const s = await spotifyStatus();
        setStatus(s);
        if (s.clientId) setClientId(s.clientId);
        if (s.connected) void refreshLibrary();
      } catch {
        // Backend unavailable - the section shows its desktop-only note.
      }
    })();
  }, [refreshLibrary]);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const s = await spotifyConnect(clientId);
      setStatus(s);
      void refreshLibrary();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    try {
      await spotifyDisconnect();
      setStatus((prev) => (prev ? { ...prev, connected: false, displayName: null } : prev));
      setLibrary(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Feed one item to the importer. The synced mark waits for the download
   * to finish (the pending registry, settled by the downloads provider), so
   * a failed download stays offered rather than lying "Synced".
   */
  const syncOne = async (key: string, url: string, snapshot?: string) => {
    setSyncing((prev) => new Set(prev).add(key));
    setError(null);
    try {
      const job = await enqueue(url);
      registerPendingSync(job.id, key, snapshot);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  /** Everything new or changed (and importable), queued one after another. */
  const syncAll = async () => {
    if (!library) return;
    const albums = library.albums.filter((a) => !a.synced);
    const playlists = library.playlists.filter((p) => p.state !== 'synced' && p.public);
    setError(null);
    try {
      for (const album of albums) {
        const key = `album:${album.id}`;
        setSyncing((prev) => new Set(prev).add(key));
        try {
          const job = await enqueue(album.url);
          registerPendingSync(job.id, key);
        } finally {
          setSyncing((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
      for (const playlist of playlists) {
        const key = `playlist:${playlist.id}`;
        setSyncing((prev) => new Set(prev).add(key));
        try {
          const job = await enqueue(playlist.url);
          registerPendingSync(job.id, key, playlist.snapshotId);
        } finally {
          setSyncing((prev) => {
            const next = new Set(prev);
            next.delete(key);
            return next;
          });
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(new Set());
      void refreshLibrary();
    }
  };

  if (!isTauri()) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          Spotify sync needs the download engine, which only runs in the desktop app.
        </Text>
      </div>
    );
  }

  // What "Sync all" would queue: unsynced albums, plus unsynced playlists
  // the importer can actually reach (it reads public pages only).
  const pending = library
    ? library.albums.filter((a) => !a.synced).length +
      library.playlists.filter((p) => p.state !== 'synced' && p.public).length
    : 0;

  /** Whether an item's URL is already sitting in the download queue. */
  const queued = (url: string) =>
    jobs.some((j) => j.url === url && (j.state === 'queued' || j.state === 'downloading'));

  return (
    <div className="prefsBody">
      {!status?.connected ? (
        <div className="prefsSection">
          <Label>Connect Spotify</Label>
          <Text tone="muted" size="sm">
            Syncing reads your saved albums and playlists and feeds them to the importer. It
            uses your own (free) Spotify app: create one at developer.spotify.com, add{' '}
            <code>{status?.redirectUri ?? 'http://127.0.0.1:8898/callback'}</code> as a Redirect
            URI, and paste its Client ID here.
          </Text>
          <Field label="Client ID">
            <Input
              value={clientId}
              onChange={(e) => setClientId(e.currentTarget.value)}
              placeholder="Your Spotify app's Client ID"
              aria-label="Spotify Client ID"
            />
          </Field>
          <div className="prefsActions">
            <Button
              variant="solid"
              size="sm"
              disabled={!clientId.trim() || connecting}
              onClick={() => void connect()}
            >
              {connecting ? 'Waiting for your browser…' : 'Connect Spotify'}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="prefsSection">
            <Label>Account</Label>
            <div className="spotifyAccountRow">
              <Text size="sm">
                Connected{status.displayName ? ` as ${status.displayName}` : ''}.
              </Text>
              <div className="prefsActions">
                <Button variant="outline" size="sm" disabled={loadingLibrary} onClick={() => void refreshLibrary()}>
                  {loadingLibrary ? 'Refreshing…' : 'Refresh'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void disconnect()}>
                  Disconnect
                </Button>
              </div>
            </div>
          </div>

          {library && (
            <div className="prefsSection">
              <div className="spotifyAccountRow">
                <Label>Library</Label>
                <Button
                  variant="solid"
                  size="sm"
                  disabled={pending === 0 || syncing.size > 0}
                  onClick={() => void syncAll()}
                >
                  {syncing.size > 0
                    ? `Syncing ${syncing.size}…`
                    : pending === 0
                      ? 'Everything synced'
                      : `Sync ${pending} new`}
                </Button>
              </div>
              <Text tone="muted" size="sm">
                Synced items are marked once their download finishes; private playlists cannot
                be fetched by the importer.
              </Text>
              <SpotifyList
                albums={library.albums}
                playlists={library.playlists}
                syncing={syncing}
                queued={queued}
                onSync={syncOne}
              />
            </div>
          )}
        </>
      )}
      {error && (
        <Text tone="danger" size="sm">
          {error}
        </Text>
      )}
    </div>
  );
}

function SpotifyList({
  albums,
  playlists,
  syncing,
  queued,
  onSync,
}: {
  albums: SpotifyAlbum[];
  playlists: SpotifyPlaylist[];
  syncing: Set<string>;
  queued: (url: string) => boolean;
  onSync: (key: string, url: string, snapshot?: string) => Promise<void>;
}) {
  return (
    <div className="spotifyLists">
      {playlists.length > 0 && (
        <>
          <Text tone="muted" size="sm">Playlists ({playlists.length})</Text>
          {playlists.map((playlist) => {
            const key = `playlist:${playlist.id}`;
            return (
              <SpotifyRow
                key={key}
                image={playlist.image}
                name={playlist.name}
                detail={`${playlist.owner || 'Playlist'} · ${playlist.tracks} tracks`}
                state={playlist.state}
                privateItem={!playlist.public}
                busy={syncing.has(key)}
                queued={queued(playlist.url)}
                onSync={() => void onSync(key, playlist.url, playlist.snapshotId)}
              />
            );
          })}
        </>
      )}
      {albums.length > 0 && (
        <>
          <Text tone="muted" size="sm">Albums ({albums.length})</Text>
          {albums.map((album) => {
            const key = `album:${album.id}`;
            return (
              <SpotifyRow
                key={key}
                image={album.image}
                name={album.name}
                detail={`${album.artist} · ${album.tracks} tracks`}
                state={album.synced ? 'synced' : 'new'}
                privateItem={false}
                busy={syncing.has(key)}
                queued={queued(album.url)}
                onSync={() => void onSync(key, album.url)}
              />
            );
          })}
        </>
      )}
      {albums.length === 0 && playlists.length === 0 && (
        <Text tone="muted" size="sm">Nothing saved on this account yet.</Text>
      )}
    </div>
  );
}

function SpotifyRow({
  image,
  name,
  detail,
  state,
  privateItem,
  busy,
  queued,
  onSync,
}: {
  image: string | null;
  name: string;
  detail: string;
  state: 'new' | 'changed' | 'synced';
  /** Private/collaborative: the public-page importer cannot fetch it. */
  privateItem: boolean;
  busy: boolean;
  /** Already sitting in the download queue - synced once it finishes. */
  queued: boolean;
  onSync: () => void;
}) {
  return (
    <div className="spotifyRow">
      {image ? (
        <img className="spotifyRowArt" src={image} alt="" loading="lazy" />
      ) : (
        <span className="spotifyRowArt" aria-hidden="true" />
      )}
      <div className="spotifyRowCopy">
        <Text size="sm" className="spotifyRowName">{name}</Text>
        <Text tone="muted" size="sm">{detail}</Text>
      </div>
      {state === 'synced' ? (
        <Pill size="sm" tone="success">Synced</Pill>
      ) : privateItem ? (
        <Pill size="sm" tone="neutral" title="Make it public on Spotify to sync it">Private</Pill>
      ) : queued ? (
        <Pill size="sm" tone="neutral">Downloading…</Pill>
      ) : (
        <Button variant="outline" size="sm" disabled={busy} onClick={onSync}>
          {busy ? 'Queuing…' : state === 'changed' ? 'Sync changes' : 'Sync'}
        </Button>
      )}
    </div>
  );
}
