import { Button, Field, Input, Label, Pill, Text } from '@glacier/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useServerSession } from '@attackfm/app/serverSession';
import { openExternal } from '@attackfm/app/openExternal';
import {
  spotifyBeginConnect,
  spotifyDisconnect,
  spotifyLibrary,
  spotifyStatus,
  spotifySync,
  spotifySyncStatus,
  spotifyWatch,
  type SpotifyAlbum,
  type SpotifyLibrary,
  type SpotifyMirror,
  type SpotifyPlaylist,
  type SpotifyStatus,
  type SpotifySyncStatus,
} from './spotifyAccount.ts';

/**
 * The Spotify tab: connect an account, then choose what to keep. Everything
 * after that choice belongs to the HUB - it reads each collection as you over
 * the Web API, works out which of its tracks the library already has,
 * downloads the rest, and rebuilds the local playlist in Spotify's order. So
 * this is glue: list the account, offer a switch per collection, and report
 * what the server says it has done.
 */
export function SpotifyAccountSettings() {
  const { session } = useServerSession();
  const [status, setStatus] = useState<SpotifyStatus | null>(null);
  const [clientId, setClientId] = useState('');
  /** Only shown on request once the server already has an id to offer. */
  const [showClientId, setShowClientId] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [library, setLibrary] = useState<SpotifyLibrary | null>(null);
  const [loadingLibrary, setLoadingLibrary] = useState(false);
  const [sync, setSync] = useState<SpotifySyncStatus | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const refreshLibrary = useCallback(async () => {
    if (!session) return;
    setLoadingLibrary(true);
    setError(null);
    try {
      setLibrary(await spotifyLibrary(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingLibrary(false);
    }
  }, [session]);

  useEffect(() => {
    if (!session) return;
    void (async () => {
      try {
        const s = await spotifyStatus(session);
        setStatus(s);
        if (s.clientId) setClientId(s.clientId);
        if (s.connected) void refreshLibrary();
      } catch {
        // Hub unreachable - the section shows its connect-a-server note.
      }
    })();
  }, [session, refreshLibrary]);

  const connect = async () => {
    if (!session) return;
    setConnecting(true);
    setError(null);
    try {
      // The hub parks the login and hands back the authorize URL; the browser
      // returns to the SERVER, so from here it is a poll until status flips.
      const { authorizeUrl } = await spotifyBeginConnect(session, clientId);
      await openExternal(authorizeUrl);
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5 * 60 * 1000) {
        await new Promise((resolve) => setTimeout(resolve, 2500));
        const s = await spotifyStatus(session);
        if (s.connected) {
          setStatus(s);
          void refreshLibrary();
          return;
        }
      }
      setError('Spotify login timed out - try connecting again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  const disconnect = async () => {
    if (!session) return;
    try {
      await spotifyDisconnect(session);
      setStatus((prev) => (prev ? { ...prev, connected: false, displayName: null } : prev));
      setLibrary(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /**
   * Poll the server's own progress while anything is moving. Every number
   * comes from its tables rather than from state kept here, so two devices
   * watching the same sync agree, and a reload mid-sync loses nothing.
   */
  useEffect(() => {
    if (!session || !status?.connected) return;
    let live = true;
    const tick = async () => {
      try {
        const next = await spotifySyncStatus(session);
        if (live) setSync(next);
      } catch {
        // A blip: the next tick picks it back up.
      }
    };
    void tick();
    const working = sync?.phase === 'working';
    const timer = setInterval(() => void tick(), working ? 4000 : 20000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [session, status?.connected, sync?.phase]);

  const mirrors = useMemo(() => {
    const map = new Map<string, SpotifyMirror>();
    for (const item of sync?.items ?? []) map.set(item.key, item);
    return map;
  }, [sync]);

  /**
   * Turn tracking on or off for one collection. This is the entire user-facing
   * action: from here the server enumerates, matches, downloads and rebuilds
   * on its own schedule, and keeps doing so as the playlist changes upstream.
   */
  const toggleWatch = async (key: string, on: boolean) => {
    if (!session) return;
    setBusy((prev) => new Set(prev).add(key));
    setError(null);
    try {
      await spotifyWatch(session, [{ key, watch: on }]);
      if (on) await spotifySync(session, [key]);
      setSync(await spotifySyncStatus(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  /** Ask for a pass over everything tracked, now rather than at the next tick. */
  const syncAllNow = async () => {
    if (!session) return;
    setError(null);
    try {
      await spotifySync(session);
      setSync(await spotifySyncStatus(session));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!session) {
    return (
      <div className="prefsBody">
        <Text tone="muted" size="sm">
          Spotify sync runs on your server - connect one under Settings &rarr; Server
          first.
        </Text>
      </div>
    );
  }

  return (
    <div className="prefsBody">
      {!status?.connected ? (
        <div className="prefsSection">
          <Label>Connect Spotify</Label>
          {/* The server knows which Spotify app to use - either this listener
              connected before, or the hub carries one - so connecting is a
              button, and the id only appears if you ask to change it. */}
          {status?.clientId && !showClientId ? (
            <>
              <Text tone="muted" size="sm">
                Sign in to read your saved albums and playlists. Your server holds the
                connection, so every device sees it{status.clientIdFromServer ? ' — this hub supplies the Spotify app' : ''}.
              </Text>
              <div className="prefsActions">
                <Button variant="solid" size="sm" disabled={connecting} onClick={() => void connect()}>
                  {connecting ? 'Waiting for your browser…' : 'Log in with Spotify'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setShowClientId(true)}>
                  Use a different app
                </Button>
              </div>
            </>
          ) : (
            <>
              <Text tone="muted" size="sm">
                Syncing reads your saved albums and playlists. It uses a (free) Spotify app:
                create one at developer.spotify.com, add{' '}
                <code>{status?.redirectUri ?? 'your server’s /api/spotify/callback'}</code> as a
                Redirect URI, and paste its Client ID here.
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
                {status?.clientId && (
                  <Button variant="ghost" size="sm" onClick={() => setShowClientId(false)}>
                    Cancel
                  </Button>
                )}
              </div>
            </>
          )}
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
                  variant="outline"
                  size="sm"
                  disabled={(sync?.totals.watched ?? 0) === 0}
                  onClick={() => void syncAllNow()}
                >
                  Check for changes
                </Button>
              </div>
              <Text tone="muted" size="sm">
                {sync && sync.totals.watched > 0 ? (
                  <>
                    Keeping {sync.totals.watched}{' '}
                    {sync.totals.watched === 1 ? 'collection' : 'collections'} in step —{' '}
                    {sync.totals.resolved} of {sync.totals.tracks} tracks here
                    {sync.totals.queued > 0 ? `, ${sync.totals.queued} downloading` : ''}
                    {sync.totals.missing > 0 ? `, ${sync.totals.missing} not found` : ''}.
                  </>
                ) : (
                  <>
                    Turn on Keep tracked and this server mirrors the collection into a real
                    playlist, downloading whatever the library is missing and following it as it
                    changes. Private and collaborative playlists work too.
                  </>
                )}
              </Text>
              <SpotifyList
                albums={library.albums}
                playlists={library.playlists}
                mirrors={mirrors}
                busy={busy}
                onToggle={toggleWatch}
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
  mirrors,
  busy,
  onToggle,
}: {
  albums: SpotifyAlbum[];
  playlists: SpotifyPlaylist[];
  mirrors: Map<string, SpotifyMirror>;
  busy: Set<string>;
  onToggle: (key: string, on: boolean) => Promise<void>;
}) {
  return (
    <div className="spotifyLists">
      <Text tone="muted" size="sm">Saved songs</Text>
      <SpotifyRow
        image={null}
        name="Liked Songs"
        detail="Everything you have saved on Spotify"
        mirror={mirrors.get('liked')}
        busy={busy.has('liked')}
        onToggle={(on) => void onToggle('liked', on)}
      />
      {playlists.length > 0 && (
        <>
          <Text tone="muted" size="sm">Playlists ({playlists.length})</Text>
          {playlists.map((playlist) => {
            const key = `playlist:${playlist.id}`;
            // Private and collaborative playlists are ordinary rows now: the
            // mirror reads them as you, so there is nothing to make public.
            const kind = playlist.public ? '' : ' · Private';
            return (
              <SpotifyRow
                key={key}
                image={playlist.image}
                name={playlist.name}
                detail={`${playlist.owner || 'Playlist'} · ${playlist.tracks} tracks${kind}`}
                mirror={mirrors.get(key)}
                busy={busy.has(key)}
                unsupported={playlist.unsupportedReason ?? null}
                onToggle={(on) => void onToggle(key, on)}
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
                mirror={mirrors.get(key)}
                busy={busy.has(key)}
                onToggle={(on) => void onToggle(key, on)}
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

/** What the server is doing with this collection, in a few words. */
function mirrorLabel(mirror: SpotifyMirror | undefined): { text: string; tone: 'success' | 'neutral' | 'danger' } | null {
  if (!mirror || !mirror.watch) return null;
  if (mirror.state === 'error') return { text: 'Error', tone: 'danger' };
  if (mirror.state === 'enumerating') return { text: 'Reading…', tone: 'neutral' };
  if (mirror.state === 'resolving') return { text: 'Matching…', tone: 'neutral' };
  if (mirror.total === 0) return { text: 'Queued', tone: 'neutral' };
  if (mirror.state === 'synced') return { text: 'Synced', tone: 'success' };
  if (mirror.queued > 0) {
    return { text: `${mirror.resolved} of ${mirror.total} · ${mirror.queued} downloading`, tone: 'neutral' };
  }
  if (mirror.missing > 0 || mirror.ambiguous > 0) {
    return { text: `${mirror.resolved} of ${mirror.total} here`, tone: 'neutral' };
  }
  return { text: `${mirror.resolved} of ${mirror.total}`, tone: 'neutral' };
}

function SpotifyRow({
  image,
  name,
  detail,
  mirror,
  busy,
  unsupported,
  onToggle,
}: {
  image: string | null;
  name: string;
  detail: string;
  /** The server's view of this collection, absent until it is tracked. */
  mirror: SpotifyMirror | undefined;
  busy: boolean;
  /** Set when this one can never be mirrored, and why. */
  unsupported?: string | null;
  onToggle: (on: boolean) => void;
}) {
  const watched = mirror?.watch ?? false;
  const label = mirrorLabel(mirror);
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
        {unsupported ? (
          <Text tone="subtle" size="xs">{unsupported}</Text>
        ) : (
          mirror?.error && <Text tone="danger" size="sm">{mirror.error}</Text>
        )}
      </div>
      {unsupported ? (
        <Pill size="sm" tone="neutral" title={unsupported}>
          Spotify&rsquo;s own
        </Pill>
      ) : (
        <>
          {label && (
            <Pill size="sm" tone={label.tone} title={mirror?.error || undefined}>
              {label.text}
            </Pill>
          )}
          <Button
            variant={watched ? 'ghost' : 'outline'}
            size="sm"
            disabled={busy}
            onClick={() => onToggle(!watched)}
          >
            {busy ? '…' : watched ? 'Stop' : 'Keep tracked'}
          </Button>
        </>
      )}
    </div>
  );
}
