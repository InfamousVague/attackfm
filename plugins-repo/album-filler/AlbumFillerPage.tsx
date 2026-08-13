import { Button, Input, Spinner, Text } from '@glacier/react';
import { Check, Download, Search } from '@glacier/icons';
import { useMemo, useState } from 'react';
import { useLibrary } from '@attackfm/app/library';
import { useServerSession } from '@attackfm/app/serverSession';
// The HOST's bridge, not the source file: bundling that would carry a second
// React context into the plugin, and two contexts never see each other.
import { useDownloadsOptional } from '@attackfm/app/importsBridge';
import type { PluginPageProps } from '../../src/plugins/types.ts';

/**
 * Pick an artist you own; see which of their records have holes in them.
 *
 * The artist list comes from the LIBRARY, not from a catalogue search - the
 * question is only ever about music you already have some of, so offering
 * artists you own nothing by would be offering a dead end.
 */

interface MissingTrack {
  position: number | null;
  title: string;
  url: string;
}

interface AlbumGap {
  album: string;
  artist: string;
  cover: string | null;
  owned: number;
  total: number;
  missing: MissingTrack[];
}

export function AlbumFillerPage(_props: PluginPageProps) {
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const downloads = useDownloadsOptional();
  const [query, setQuery] = useState('');
  const [artist, setArtist] = useState<string | null>(null);
  const [albums, setAlbums] = useState<AlbumGap[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [sent, setSent] = useState<Set<string>>(() => new Set());

  // Your artists, most-represented first: whoever you have the most of is
  // whoever is most likely to have a record with one song missing.
  const mine = useMemo(() => {
    const counts = new Map<string, { name: string; n: number }>();
    for (const t of tracks) {
      const name = t.artist.trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const at = counts.get(key);
      if (at) at.n += 1;
      else counts.set(key, { name, n: 1 });
    }
    const all = [...counts.values()].sort((a, b) => b.n - a.n);
    const q = query.trim().toLowerCase();
    return (q ? all.filter((a) => a.name.toLowerCase().includes(q)) : all).slice(0, 24);
  }, [tracks, query]);

  const check = (name: string) => {
    if (!session) return;
    setArtist(name);
    setAlbums(null);
    setNote(null);
    setPicked(new Set());
    setBusy(true);
    fetch(`${session.url}/api/albums/gaps?artist=${encodeURIComponent(name)}`, {
      headers: { authorization: `Bearer ${session.token}` },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((out: { albums?: AlbumGap[] }) => setAlbums(out.albums ?? []))
      .catch(() => setNote('Could not reach your server to check that one.'))
      .finally(() => setBusy(false));
  };

  const keyOf = (a: AlbumGap, t: MissingTrack) => `${a.album}|${t.title}`;

  const toggle = (k: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const fill = () => {
    if (!downloads || !albums) return;
    const wanted: { key: string; url: string }[] = [];
    for (const a of albums) {
      for (const t of a.missing) {
        const k = keyOf(a, t);
        if (picked.has(k) && !sent.has(k) && t.url) wanted.push({ key: k, url: t.url });
      }
    }
    if (wanted.length === 0) return;
    // Marked as sent before the queue answers: the button must not stay live
    // under a second tap, because the import queue does not dedupe by URL and
    // a double tap is a second download of the same song.
    setSent((prev) => new Set([...prev, ...wanted.map((w) => w.key)]));
    setPicked(new Set());
    for (const w of wanted) void Promise.resolve(downloads.enqueue(w.url)).catch(() => {});
  };

  if (!session) {
    return (
      <div className="discoverPage">
        <Text tone="muted" size="sm">
          Album filler reads your library on the server — connect one under Settings → Server.
        </Text>
      </div>
    );
  }

  const chosen = picked.size;

  return (
    <div className="discoverPage">
      <div className="prefsSection">
        <Text size="lg" className="pageHeading">
          Album filler
        </Text>
        <Text tone="muted" size="sm">
          Pick someone you own and it will say which of their records have holes in them.
          Nearly-finished albums come first.
        </Text>
      </div>

      <div className="prefsSection">
        <Input
          aria-label="Find an artist"
          placeholder="Find an artist in your library"
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
        />
        <div className="afArtists">
          {mine.map((a) => (
            <button
              key={a.name}
              type="button"
              className="afArtist"
              data-active={artist === a.name || undefined}
              onClick={() => check(a.name)}
            >
              <span className="afArtist__name">{a.name}</span>
              <span className="afArtist__count">{a.n}</span>
            </button>
          ))}
          {mine.length === 0 && (
            <Text tone="muted" size="sm">
              Nothing in your library matches that.
            </Text>
          )}
        </div>
      </div>

      {busy && (
        <div className="booksSearching">
          <Spinner /> <Text tone="muted" size="sm">Checking {artist} against the catalogue…</Text>
        </div>
      )}

      {note && (
        <Text tone="danger" size="sm">
          {note}
        </Text>
      )}

      {albums && albums.length === 0 && !busy && (
        <Text tone="muted" size="sm">
          Nothing missing that I can see — every {artist} record you own looks complete.
        </Text>
      )}

      {albums && albums.length > 0 && (
        <div className="prefsSection">
          {albums.map((a) => (
            <div key={a.album} className="afAlbum">
              <div className="afAlbum__head">
                {a.cover && <img className="afAlbum__art" src={a.cover} alt="" loading="lazy" />}
                <div className="afAlbum__text">
                  <span className="afAlbum__title">{a.album}</span>
                  <Text tone="muted" size="xs">
                    {a.owned} of {a.total} · {a.missing.length} missing
                  </Text>
                </div>
              </div>
              <div className="afRows">
                {a.missing.map((t) => {
                  const k = keyOf(a, t);
                  const done = sent.has(k);
                  return (
                    <button
                      key={k}
                      type="button"
                      className="afRow"
                      data-picked={picked.has(k) || undefined}
                      disabled={done || !t.url}
                      onClick={() => toggle(k)}
                    >
                      <span className="afRow__no">{t.position ?? '·'}</span>
                      <span className="afRow__title">{t.title}</span>
                      <span className="afRow__mark">
                        {done ? <Check size={15} /> : picked.has(k) ? <Check size={15} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {chosen > 0 && (
        <div className="afBar">
          <Button variant="solid" size="sm" disabled={!downloads} onClick={fill}>
            <Download size={15} /> Get {chosen} {chosen === 1 ? 'song' : 'songs'}
          </Button>
          {!downloads && (
            <Text tone="muted" size="xs">
              Turn on Music import to fetch these.
            </Text>
          )}
        </div>
      )}
    </div>
  );
}
