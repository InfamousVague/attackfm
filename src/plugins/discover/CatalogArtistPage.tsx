import { Text } from '@glacier/react';
import { ChevronLeft, Check, Disc3, Music, Play, Plus, User, X } from '@glacier/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useRippleWave } from '../../app/ux/rippleWave.ts';
import { useServerSession } from '../../app/servers/serverSession.tsx';
import {
  fetchCatalogArtist,
  type CatalogArtist,
  type CatalogRelease,
  type CatalogTrack,
} from '../../app/server.ts';
import { useOwned } from '../../app/library/owned.ts';
import { useArtLoad } from '../../app/ux/artLoad.ts';
import { PROBE_URL, resolveImportable } from '../../app/search/resolveImport.ts';
import { useDownloadsOptional } from '../importsBridge.ts';
import { IMPORTER_PLUGIN_ID, useAcquire } from '../runtime.tsx';
import type { AcquireTarget } from '../types.ts';
import type { Track } from '../../app/core/tauri.ts';

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

/** A catalogue cover or portrait <img>, wearing the shared skeleton/pulse.
 *  Its own component because rows and release cards render through map
 *  callbacks, where a hook cannot live. External catalogue art, so the URL
 *  is used as-is - no server size variants to ask for. */
function CatalogArt({ src, className, lazy }: { src: string; className?: string; lazy?: boolean }) {
  const art = useArtLoad(src, className ?? '');
  return <img {...art} src={src} alt="" loading={lazy ? 'lazy' : undefined} />;
}

export function CatalogArtistPage({
  artistId,
  artistName,
  backLabel,
  onBack,
  onOpenArtist,
  onTrackQueued,
  onPlay,
}: {
  artistId: string;
  artistName: string;
  /** Where Back goes: the artist read before this one, or "Discover". */
  backLabel: string;
  onBack: () => void;
  /** Told the job id when a single track is queued, so the page that owns the
   *  deck can start it playing the moment the import lands. */
  onTrackQueued?: (jobId: string) => void;
  /** Plays a song the library already holds. A row wearing a check IS a song
   *  you own, so the tap that would have fetched it starts it instead. */
  onPlay?: (track: Track, queue: Track[]) => void;
  /** Walks to a related artist, staying on this page's shape. */
  onOpenArtist: (id: string, name: string) => void;
}) {
  // Releases and tracks ride the same wave as everywhere else.
  const rippleRoot = useRef<HTMLDivElement>(null);
  useRippleWave(rippleRoot);
  const { session } = useServerSession();
  const downloads = useDownloadsOptional();
  const acquire = useAcquire();
  const owned = useOwned();
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
  // queue, and - for a song - autoplay once it lands) whenever it can service
  // the target; only with it off does the chooser come out.
  const runAcquire = (target: AcquireTarget, url: string, key: string, armPlay: boolean) => {
    const hs = acquire.handlersFor(target);
    if (hs.some((h) => h.pluginId === IMPORTER_PLUGIN_ID)) enqueue(url, key, armPlay);
    else acquire.acquire(target);
  };

  /**
   * Pull something whose own link the importer will not take.
   *
   * This whole page is Deezer, and the importer refuses a Deezer link as
   * primary input, so a tap finds the same record or song on Spotify by name
   * and hands over that instead. Rows whose link is already importable skip
   * the lookup entirely.
   */
  const runResolved = async (
    kind: 'album' | 'track',
    title: string,
    url: string,
    key: string,
    importable: boolean,
    armPlay: boolean,
  ) => {
    const target: AcquireTarget = { kind, title, artist: artistName, url };
    if (importable) {
      runAcquire(target, url, key, armPlay);
      return;
    }
    if (!session) return;
    setTapped((prev) => ({ ...prev, [key]: 'adding' }));
    let found = null;
    try {
      found = await resolveImportable(session, kind, artistName, title);
    } catch {
      // Offline, or the catalogue refused - same outcome as "not there".
    }
    if (!found) {
      setMissing((prev) => ({ ...prev, [key]: true }));
      setTapped((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      // Long enough to read, then the row is a live offer again so the tap
      // doubles as the retry.
      window.setTimeout(
        () =>
          setMissing((prev) => {
            const next = { ...prev };
            delete next[key];
            return next;
          }),
        4000,
      );
      return;
    }
    runAcquire({ ...target, title: found.title, url: found.url }, found.url, key, armPlay);
  };
  const [artist, setArtist] = useState<CatalogArtist | null>(null);
  const [failed, setFailed] = useState(false);
  // Taps, so a button answers before the queue has caught up. The queue's own
  // word wins once it has one - see addState.
  const [tapped, setTapped] = useState<Record<string, AddState>>({});
  // Rows whose Spotify lookup came back empty, so the page can say so on the
  // row rather than appearing to have ignored the tap.
  const [missing, setMissing] = useState<Record<string, boolean>>({});

  // What this page can actually play: the top tracks you already own, in the
  // page's own order. Starting a song here queues these behind it, so the
  // artist plays on instead of stopping after one.
  const ownedTop = useMemo(
    () =>
      (artist?.top ?? [])
        .map((t) => owned.find(artistName, t.title))
        .filter((t): t is Track => t !== null),
    [artist, artistName, owned],
  );

  useEffect(() => {
    if (!session) return;
    const ctrl = new AbortController();
    setArtist(null);
    setFailed(false);
    setTapped({});
    setMissing({});
    void fetchCatalogArtist(session, artistId, artistName, ctrl.signal)
      .then(setArtist)
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [session, artistId, artistName]);

  /** A row's Add state. `title` is given for songs, whose presence in the
   *  library is knowable by name - so a song you already have wears its check
   *  the first time the page opens, not just after this session downloaded it.
   *  A release has no such test (owning three of its twelve tracks is not
   *  owning the record), so it answers from the queue alone. */
  const addState = (url: string, key: string, title?: string): AddState => {
    if (title !== undefined && owned.has(artistName, title)) return 'added';
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
    const gone = missing[r.id] === true;
    // A record whose own link the importer will not take is still addable -
    // the tap looks it up on Spotify first. So the only thing that disables a
    // card is having no acquire handler at all.
    const canAdd = acquire.hasHandlers({ ...releaseTarget(r), url: PROBE_URL });
    return (
      <button
        key={r.id}
        type="button"
        className="resultCard"
        data-kind="release"
        data-missing={gone || undefined}
        disabled={state !== 'idle' || !canAdd || gone}
        title={
          gone
            ? `${r.title} is not on Spotify to import`
            : canAdd
              ? undefined
              : 'No way to add this — enable Music import or Buy in Plugins'
        }
        onClick={() => void runResolved('album', r.title, r.url, r.id, r.importable, false)}
      >
        <span className="resultCard__cover" data-kind="release">
          {r.cover ? <CatalogArt src={r.cover} lazy /> : <Disc3 size={22} />}
        </span>
        <span className="resultCard__title">{r.title}</span>
        <span className="resultCard__sub">
          {[r.year, r.trackCount ? `${r.trackCount} tracks` : null].filter(Boolean).join(' · ')}
        </span>
        {(canAdd || state !== 'idle') && (
          <span className="resultCard__badge" data-state={gone ? 'missing' : state}>
            {gone ? <X size={14} /> : addGlyph(state)}
          </span>
        )}
      </button>
    );
  };

  const trackRow = (t: CatalogTrack, index: number) => {
    const state = addState(t.url, t.id, t.title);
    const gone = missing[t.id] === true;
    const canAdd = acquire.hasHandlers({ ...trackTarget(t), url: PROBE_URL });
    // A song already in the library: the row stops being an offer and becomes
    // a song - the name and the check both start it, with the rest of what
    // you own by this artist behind it so the page plays on.
    const mine = onPlay ? owned.find(artistName, t.title) : null;
    const play = mine
      ? () => onPlay!(mine, ownedTop.length > 0 ? ownedTop : [mine])
      : null;
    return (
      <li key={t.id} className="catalogTrack" data-playable={play ? '' : undefined}>
        <span className="catalogTrack__rank">{index + 1}</span>
        {t.cover ? (
          <CatalogArt src={t.cover} className="catalogTrack__art" lazy />
        ) : (
          <span className="catalogTrack__art catalogTrack__art--glyph" aria-hidden>
            <Music size={16} />
          </span>
        )}
        {play ? (
          <button type="button" className="catalogTrack__title catalogTrack__title--play" onClick={play}>
            {t.title}
          </button>
        ) : (
          <span className="catalogTrack__title">{t.title}</span>
        )}
        <span className="catalogTrack__time">{trackTime(t.duration)}</span>
        <button
          type="button"
          className="catalogTrack__add"
          data-state={gone ? 'missing' : play ? 'owned' : state}
          disabled={play ? false : state !== 'idle' || !canAdd || gone}
          aria-label={
            play ? `Play ${t.title}` : gone ? `${t.title} is not on Spotify` : `Add ${t.title}`
          }
          title={
            play
              ? undefined
              : gone
                ? `${t.title} is not on Spotify to import`
                : canAdd
                  ? undefined
                  : 'No way to add this — enable Music import or Buy in Plugins'
          }
          onClick={
            play ? play : () => void runResolved('track', t.title, t.url, t.id, t.importable, true)
          }
        >
          {/* Owned rows swap the check for a play on hover, the way the search
              page's owned badge does - the check says you have it, the play
              says what the tap will do. */}
          {play ? (
            <>
              <Check size={14} className="catalogTrack__have" />
              <Play size={14} className="catalogTrack__go" />
            </>
          ) : gone ? (
            <X size={14} />
          ) : (
            addGlyph(state)
          )}
        </button>
      </li>
    );
  };

  return (
    <div className="discoverPage catalogArtist" ref={rippleRoot}>
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
                <CatalogArt src={artist.picture} />
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
              The catalogue lists no releases for {artist.name}.
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
                      {r.picture ? <CatalogArt src={r.picture} lazy /> : <User size={22} />}
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
