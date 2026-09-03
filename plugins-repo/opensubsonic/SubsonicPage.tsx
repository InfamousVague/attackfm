import { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Pill, ProgressBar, Spinner, Text } from '@glacier/react';
import { Disc3, Download, ListMusic, RefreshCw, Star, Upload } from '@glacier/icons';
import { useServerSession } from '@attackfm/app/serverSession';
import { usePlaylists } from '@attackfm/app/playlists';
import {
  exportPlaylist,
  fetchJobs,
  fetchRemote,
  remoteAlbums,
  remotePlaylists,
  remoteStarred,
  startImport,
  type ImportJob,
  type RemoteAlbum,
  type RemotePlaylist,
  type RemoteStatus,
} from './api.ts';

/**
 * The other server, as a page: what it holds, ticked, and one button that
 * brings it here.
 *
 * The work happens on the hub, not on this device - it is the hub that has
 * the library to file songs into and the disk to put them on, and a phone
 * that goes to sleep mid-import should not lose the import. So this page
 * starts a job and then watches it, the same shape the music importer uses.
 *
 * Songs already here are LINKED rather than fetched again, matched on
 * title/artist/album and then on title/artist within a few seconds of the
 * same length. That is why a second run of the same playlist downloads
 * nothing and still rebuilds the list.
 */
export function SubsonicPage({ onOpenPlaylist }: { onOpenPlaylist?: (id: string) => void }) {
  const { session } = useServerSession();
  const { playlists } = usePlaylists();
  const [remote, setRemote] = useState<RemoteStatus | null>(null);
  const [lists, setLists] = useState<RemotePlaylist[]>([]);
  const [albums, setAlbums] = useState<RemoteAlbum[]>([]);
  const [starred, setStarred] = useState<{ count: number; have: number } | null>(null);
  const [pickedLists, setPickedLists] = useState<Set<string>>(new Set());
  const [pickedAlbums, setPickedAlbums] = useState<Set<string>>(new Set());
  const [withStars, setWithStars] = useState(false);
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    try {
      const status = await fetchRemote(session);
      setRemote(status);
      if (status.connected) {
        const [p, a, s] = await Promise.all([
          remotePlaylists(session).catch(() => ({ playlists: [] })),
          remoteAlbums(session).catch(() => ({ albums: [], offset: 0 })),
          remoteStarred(session).catch(() => ({ count: 0, have: 0, songs: [] })),
        ]);
        setLists(p.playlists);
        setAlbums(a.albums);
        setStarred({ count: s.count, have: s.have });
      }
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'That server did not answer.' });
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void load();
  }, [load]);

  // While a job runs, watch it. Stops as soon as nothing is moving, so an
  // idle page costs nothing.
  const running = jobs.some((j) => j.state === 'running' || j.state === 'queued');
  useEffect(() => {
    if (!session) return undefined;
    let live = true;
    const tick = () => {
      void fetchJobs(session)
        .then((r) => live && setJobs(r.jobs))
        .catch(() => {});
    };
    tick();
    const timer = window.setInterval(tick, running ? 1500 : 15_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [session, running]);

  // A finished job means new songs and maybe new playlists: the library
  // pulls them in on its own sync, and the list below shows what landed.
  const latest = jobs[0];

  if (!session) {
    return (
      <div className="pluginPage">
        <Text tone="muted">Connect a server first - the import runs there.</Text>
      </div>
    );
  }

  if (loading && !remote) {
    return (
      <div className="pluginPage">
        <Spinner aria-label="Reading" />
      </div>
    );
  }

  if (!remote?.connected) {
    return (
      <div className="pluginPage">
        <h2>No other server yet</h2>
        <Text tone="muted">
          Add one under Settings &rarr; OpenSubsonic: its address and your account there. Navidrome,
          Airsonic, Gonic and another AttackFM all speak this.
        </Text>
      </div>
    );
  }

  const toggle = (set: Set<string>, id: string, put: (s: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    put(next);
  };

  const chosen = pickedLists.size + pickedAlbums.size + (withStars ? 1 : 0);

  const bring = async () => {
    setBusy(true);
    setNote(null);
    try {
      await startImport(session, {
        playlists: [...pickedLists],
        albums: [...pickedAlbums],
        starred: withStars,
      });
      setPickedLists(new Set());
      setPickedAlbums(new Set());
      setWithStars(false);
      const r = await fetchJobs(session);
      setJobs(r.jobs);
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'That did not start.' });
    } finally {
      setBusy(false);
    }
  };

  const send = async (id: string) => {
    setBusy(true);
    setNote(null);
    try {
      const out = await exportPlaylist(session, Number(id));
      setNote({
        tone: 'ok',
        text:
          `${out.name}: ${out.matched} song${out.matched === 1 ? '' : 's'} ${out.replaced ? 'updated' : 'sent'} over` +
          (out.missed > 0 ? `, ${out.missed} not on that server` : '.'),
      });
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'That did not go over.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pluginPage subsonicPage">
      <header className="subsonicPage__head">
        <div>
          <h2>{remote.url?.replace(/^https?:\/\//, '')}</h2>
          <Text tone="muted" size="sm">
            as {remote.username}
            {remote.serverType ? ` · ${remote.serverType}` : ''}
          </Text>
        </div>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={15} /> Refresh
        </Button>
      </header>

      {note && (
        <Text size="sm" tone={note.tone === 'ok' ? 'success' : 'danger'}>
          {note.text}
        </Text>
      )}

      {latest && (
        <section className="subsonicJob">
          <div className="subsonicJob__head">
            <span>{latest.title}</span>
            <Pill tone={latest.state === 'done' ? 'success' : 'info'}>
              {latest.state === 'done' ? 'done' : latest.current || latest.state}
            </Pill>
          </div>
          {latest.total > 0 && (
            <ProgressBar value={latest.done} max={latest.total} aria-label="Bringing songs over" />
          )}
          <Text tone="muted" size="xs">
            {latest.downloaded} brought over · {latest.linked} already here
            {latest.starred > 0 ? ` · ${latest.starred} starred` : ''}
            {latest.failed > 0 ? ` · ${latest.failed} could not be fetched` : ''}
          </Text>
          {latest.playlists.length > 0 && (
            <div className="subsonicJob__made">
              {latest.playlists.map((p) => (
                <Button
                  key={p.id}
                  variant="ghost"
                  size="sm"
                  onClick={() => onOpenPlaylist?.(String(p.id))}
                  disabled={!onOpenPlaylist}
                >
                  <ListMusic size={14} /> {p.name} · {p.songs}
                </Button>
              ))}
            </div>
          )}
          {latest.failed > 0 && latest.log.length > 0 && (
            <details className="subsonicJob__log">
              <summary>What did not come over</summary>
              <ul>
                {latest.log.slice(-12).map((line, i) => (
                  <li key={i}>{line}</li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      <section className="subsonicPick">
        <h3>
          <ListMusic size={16} /> Playlists there
        </h3>
        {lists.length === 0 ? (
          <Text tone="muted" size="sm">
            None on that server.
          </Text>
        ) : (
          <ul className="subsonicList">
            {lists.map((p) => (
              <li key={p.id}>
                <Checkbox
                  checked={pickedLists.has(p.id)}
                  onCheckedChange={() => toggle(pickedLists, p.id, setPickedLists)}
                  label={p.name}
                />
                <Text tone="muted" size="xs">
                  {p.songCount} song{p.songCount === 1 ? '' : 's'}
                  {p.owner ? ` · ${p.owner}` : ''}
                  {p.haveByName ? ' · you have a list by this name' : ''}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </section>

      {starred && starred.count > 0 && (
        <section className="subsonicPick">
          <h3>
            <Star size={16} /> Starred there
          </h3>
          <Checkbox
            checked={withStars}
            onCheckedChange={() => setWithStars((v) => !v)}
            label={`${starred.count} starred song${starred.count === 1 ? '' : 's'}`}
          />
          <Text tone="muted" size="xs">
            {starred.have} of them are already in this library; the rest would be brought over. They
            land in your Liked songs.
          </Text>
        </section>
      )}

      <section className="subsonicPick">
        <h3>
          <Disc3 size={16} /> Albums there
        </h3>
        {albums.length === 0 ? (
          <Text tone="muted" size="sm">
            Nothing to show.
          </Text>
        ) : (
          <ul className="subsonicList">
            {albums.map((a) => (
              <li key={a.id}>
                <Checkbox
                  checked={pickedAlbums.has(a.id)}
                  onCheckedChange={() => toggle(pickedAlbums, a.id, setPickedAlbums)}
                  label={a.name}
                />
                <Text tone="muted" size="xs">
                  {a.artist}
                  {a.year ? ` · ${a.year}` : ''} · {a.songCount} song{a.songCount === 1 ? '' : 's'}
                </Text>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="subsonicPage__go">
        <Button variant="solid" size="lg" disabled={chosen === 0 || busy || running} onClick={() => void bring()}>
          <Download size={16} />
          {running ? 'Bringing music over…' : chosen === 0 ? 'Pick something first' : `Bring ${chosen} over`}
        </Button>
      </div>

      <section className="subsonicPick">
        <h3>
          <Upload size={16} /> Send a playlist there
        </h3>
        <Text tone="muted" size="sm">
          Each song is looked up on the other server by name; the list is made there with the ones it
          has, and refreshed rather than duplicated if you send it again.
        </Text>
        {playlists.length === 0 ? (
          <Text tone="muted" size="sm">
            You have no playlists yet.
          </Text>
        ) : (
          <ul className="subsonicList">
            {playlists.map((p) => (
              <li key={p.id}>
                <span>{p.name}</span>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => void send(p.id)}>
                  <Upload size={14} /> Send
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
