import { Text } from '@glacier/react';
import { ChevronLeft, Check, Disc3, Music, Plus, User } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useServerSession } from '../../app/serverSession.tsx';
import {
  fetchCatalogArtist,
  type CatalogArtist,
  type CatalogRelease,
  type CatalogTrack,
} from '../../app/server.ts';
import { useDownloadsOptional } from '../importsBridge.ts';
import { useAcquire } from '../runtime.tsx';
import type { AcquireTarget } from '../types.ts';

/**
 * One catalogue artist, opened from a Discover search row: who they are, how
 * big they are, and everything they have released - albums and singles apart,
 * newest first - with their best-known tracks and a few neighbours to read on
 * to.
 *
 * Every record here is a thing you do not own yet, so every row is an import:
 * a track pulls the track, a release pulls the whole record through the same
 * queue the curated cards use. With the import plugin switched off the page
 * still reads as a discography, its Add buttons quietly disabled.
 *
 * It lives inside the Discover page rather than the app's own artist page,
 * which is a view of the LIBRARY - this one is a view of the catalogue, and
 * the two would disagree about what a missing album means.
 */

type AddState = 'idle' | 'adding' | 'added';

function fansLabel(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(n);
}

function trackTime(seconds: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  return `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

export function CatalogArtistPage({
  artistId,
  artistName,
  backLabel,
  onBack,
  onOpenArtist,
  onTrackQueued,
}: {
  artistId: string;
  artistName: string;
  /** Where Back goes: the artist read before this one, or "Discover". */
  backLabel: string;
  onBack: () => void;
  /** Told the job id when a single track is queued, so the page that owns the
   *  deck can start it playing the moment the import lands. */
  onTrackQueued?: (jobId: string) => void;
  /** Walks to a related artist, staying on this page's shape. */
  onOpenArtist: (id: string, name: string) => void;
}) {
  const { session } = useServerSession();
  const downloads = useDownloadsOptional();
  const acquire = useAcquire();
  // A record and a song from this catalogue, as acquire targets: the artist is
  // the page's, the title and URL the row's. Album/track kind decides who can
  // service it (Buy takes both; a downloader takes anything with a URL).
  const releaseTarget = (r: CatalogRelease): AcquireTarget => ({
    kind: 'album',
    title: r.title,
    artist: artistName,
    url: r.url,
  });
  const trackTarget = (t: CatalogTrack): AcquireTarget => ({
    kind: 'track',
    title: t.title,
    artist: artistName,
    url: t.url,
  });
  // Keep the importer's own download flow (the optimistic tap, matched to the
  // queue, and - for a song - autoplay once it lands) when it is the only way;
  // otherwise the chooser offers every handler and runs the picked one.
  const runAcquire = (target: AcquireTarget, url: string, key: string, armPlay: boolean) => {
    const hs = acquire.handlersFor(target);
    if (hs.length === 1 && hs[0]?.pluginId === 'spotify-import') enqueue(url, key, armPlay);
    else acquire.acquire(target);
  };
  const [artist, setArtist] = useState<CatalogArtist | null>(null);
  const [failed, setFailed] = useState(false);
  // Taps, so a button answers before the queue has caught up. The queue's own
  // word wins once it has one - see addState.
  const [tapped, setTapped] = useState<Record<string, AddState>>({});

  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    setArtist(null);
    setFailed(false);
    setTapped({});
    void fetchCatalogArtist(session, artistId, artistName, ctrl.signal)
      .then(setArtist)
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [session, artistId, artistName]);

  const addState = (url: string, key: string): AddState => {
    const job = downloads?.jobs?.find((j) => j.url === url) ?? null;
    if (job?.state === 'done') return 'added';
    if (job?.state === 'queued' || job?.state === 'downloading') return 'adding';
    return tapped[key] ?? 'idle';
  };

  const enqueue = (url: string, key: string, armPlay = false) => {
    if (!downloads || !url) return;
    const job = downloads.jobs?.find((j) => j.url === url) ?? null;
    if (job && job.state !== 'error') return;
    setTapped((prev) => ({ ...prev, [key]: 'adding' }));
    void Promise.resolve(downloads.enqueue(url))
      .then((queued) => {
        setTapped((prev) => ({ ...prev, [key]: 'added' }));
        // A single song is "play it when it gets here"; a whole release is a
        // library errand, not a listen-now.
        if (armPlay) onTrackQueued?.(queued.id);
      })
      .catch(() => {
        // Leave the button live so the tap is also the retry.
        setTapped((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      });
  };

  const addGlyph = (state: AddState) =>
    state === 'added' ? (
      <Check size={14} />
    ) : state === 'adding' ? (
      <span className="resultCard__spin" aria-label="Adding" />
    ) : (
      <Plus size={14} />
    );

  const releaseCard = (r: CatalogRelease) => {
    const state = addState(r.url, r.id);
    return (
      <button
        key={r.id}
        type="button"
        className="resultCard"
        data-kind="release"
        disabled={state !== 'idle' || !acquire.hasHandlers(releaseTarget(r))}
        title={
          acquire.hasHandlers(releaseTarget(r))
            ? undefined
            : 'No way to add this — enable Music import or Buy in Plugins'
        }
        onClick={() => runAcquire(releaseTarget(r), r.url, r.id, false)}
      >
        <span className="resultCard__cover" data-kind="release">
          {r.cover ? <img src={r.cover} alt="" loading="lazy" /> : <Disc3 size={22} />}
        </span>
        <span className="resultCard__title">{r.title}</span>
        <span className="resultCard__sub">
          {[r.year, r.trackCount ? `${r.trackCount} tracks` : null].filter(Boolean).join(' · ')}
        </span>
        <span className="resultCard__badge" data-state={state}>
          {addGlyph(state)}
        </span>
      </button>
    );
  };

  const trackRow = (t: CatalogTrack, index: number) => {
    const state = addState(t.url, t.id);
    return (
      <li key={t.id} className="catalogTrack">
        <span className="catalogTrack__rank">{index + 1}</span>
        {t.cover ? (
          <img className="catalogTrack__art" src={t.cover} alt="" loading="lazy" />
        ) : (
          <span className="catalogTrack__art catalogTrack__art--glyph" aria-hidden>
            <Music size={16} />
          </span>
        )}
        <span className="catalogTrack__title">{t.title}</span>
        <span className="catalogTrack__time">{trackTime(t.duration)}</span>
        <button
          type="button"
          className="catalogTrack__add"
          data-state={state}
          disabled={state !== 'idle' || !acquire.hasHandlers(trackTarget(t))}
          aria-label={`Add ${t.title}`}
          title={
            acquire.hasHandlers(trackTarget(t))
              ? undefined
              : 'No way to add this — enable Music import or Buy in Plugins'
          }
          onClick={() => runAcquire(trackTarget(t), t.url, t.id, true)}
        >
          {addGlyph(state)}
        </button>
      </li>
    );
  };

  return (
    <div className="discoverPage catalogArtist">
      <button type="button" className="catalogArtist__back" onClick={onBack}>
        <ChevronLeft size={16} />
        {backLabel}
      </button>

      {failed ? (
        <p className="discoverNote">
          Could not load {artistName || 'that artist'} — the catalogue did not answer.
        </p>
      ) : !artist ? (
        <p className="discoverNote" role="status">
          Loading {artistName || 'artist'}…
        </p>
      ) : (
        <>
          <header className="catalogArtist__head">
            <span className="catalogArtist__portrait">
              {artist.picture ? (
                <img src={artist.picture} alt="" />
              ) : (
                <User size={32} aria-hidden />
              )}
            </span>
            <div className="catalogArtist__meta">
              <Text tone="muted" size="xs" className="catalogArtist__kicker">
                Artist
              </Text>
              <h1 className="catalogArtist__name">{artist.name}</h1>
              <div className="catalogArtist__stats">
                {artist.fans != null && (
                  <span>
                    <strong>{fansLabel(artist.fans)}</strong> fans
                  </span>
                )}
                {artist.albumCount != null && (
                  <span>
                    <strong>{artist.albumCount}</strong> releases
                  </span>
                )}
                <span>
                  <strong>{artist.albums.length}</strong> albums
                </span>
                <span>
                  <strong>{artist.singles.length}</strong> singles &amp; EPs
                </span>
              </div>
            </div>
          </header>

          {artist.top.length > 0 && (
            <section className="discoverSection">
              <h2 className="discoverSection__title">Popular</h2>
              <ol className="catalogTracks">{artist.top.map(trackRow)}</ol>
            </section>
          )}

          {artist.albums.length > 0 && (
            <section className="discoverSection">
              <h2 className="discoverSection__title">Albums</h2>
              <div className="discoverGrid">{artist.albums.map(releaseCard)}</div>
            </section>
          )}

          {artist.singles.length > 0 && (
            <section className="discoverSection">
              <h2 className="discoverSection__title">Singles &amp; EPs</h2>
              <div className="discoverGrid">{artist.singles.map(releaseCard)}</div>
            </section>
          )}

          {artist.albums.length === 0 && artist.singles.length === 0 && (
            <p className="discoverNote">
              No releases listed for {artist.name} in the public catalogue.
            </p>
          )}

          {artist.related.length > 0 && (
            <section className="discoverSection">
              <h2 className="discoverSection__title">Fans also like</h2>
              <div className="discoverGrid">
                {artist.related.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className="resultCard"
                    data-kind="artist"
                    onClick={() => onOpenArtist(r.id, r.name)}
                  >
                    <span className="resultCard__cover" data-kind="artist">
                      {r.picture ? <img src={r.picture} alt="" loading="lazy" /> : <User size={22} />}
                    </span>
                    <span className="resultCard__title">{r.name}</span>
                    <span className="resultCard__sub">Artist</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
