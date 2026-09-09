import { useEffect, useMemo, useState } from 'react';
import { Button, StatTile, Text, TimeSeriesChart } from '@glacier/react';
import {
  ArrowLeft,
  ArrowUpRight,
  AudioWaveform,
  Clock,
  Disc3,
  Flame,
  Heart,
  Lock,
  Music,
  Play,
  Tag,
  User,
} from '@glacier/icons';
import { useServerSession } from '../servers/serverSession.tsx';
import { useLibrary } from '../library/library.tsx';
import { trackIdFromPath } from '../server.ts';
import { fetchMemberProfile, type MemberProfile } from '../api/profile.ts';
import { fmtMinutes, normalizeStatsSummary, type StatsRange } from './stats.ts';
import { useRegistryOptional } from '../servers/registrySession.tsx';
import { fetchRegistryProfile, RegistryError, type RegistryProfile } from '../servers/registry.ts';
import { fold, titleKey } from '../library/owned.ts';
import { RANGES, dayToLocalMs, fmtAxisMinutes, fmtDayMs, fmtHour } from './statsFormat.ts';
import { formatNumber } from '../ux/format.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { ArtChip, Heading, RowArt } from './StatsBits.tsx';
import { FriendAvatar } from './FriendAvatar.tsx';
import { FriendStats } from './RegistryFriends.tsx';
import { seenAgo } from './friendPresence.ts';
import type { RegistryFriend } from '../servers/registry.ts';
import { ArtistLink } from '../ux/ArtistLink.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import { artworkHue, artworkUrl, genreArtwork } from '../ux/artwork.ts';
import type { Track } from '../core/tauri.ts';
import './StatsPage.css';
import { ServerError, tracksOfHub } from '../server.ts';

/**
 * One friend, the whole page - by request, after the small stats modal
 * stopped being enough.
 *
 * Two registers, drawn along the wall of the house. A friend ON THIS SERVER
 * gets the full treatment: the same stats payload their own stats page is
 * built from (so this page and that one agree by construction), plus their
 * liked songs - which are playable HERE, because the two of you share the
 * library the hearts point into. A friend on another server gets the glance
 * the registry carries (minutes, top artist, streak, library counts) and an
 * honest line about why that is all: across servers, nothing richer travels.
 *
 * The whole page reuses the stats vocabulary - StatTiles, ArtChips, the
 * ranked rows - so "her stats" and "my stats" read as the same language.
 */

/** How many hearts the page lays out before pointing at the rest. */
const LIKED_SHOWN = 30;

/** One song, one key, across hubs: the artist folded, the title stripped of
 *  the noise a catalogue adds ("(Remastered)", "- Radio Edit").
 *
 *  The separator is spelled as an ESCAPE, never as a literal zero byte. Same
 *  character at runtime; the difference is on disk, where one of them makes
 *  the whole file BINARY - git prints "Bin 22846 -> 22884 bytes" in place of
 *  a diff, and `grep -r` skips it silently, so every symbol in this file is
 *  invisible to the tool this codebase is navigated and refactored with. */
function songKey(artist: string, title: string): string {
  return `${fold(artist)}\u0000${titleKey(title)}`;
}

/**
 * A profile that arrived from the registry as names, turned into the shape
 * the page below already draws: every song looked up in THIS library by
 * artist and title, and given this hub's id where it is owned (so it plays
 * and wears its art) or -1 where it is not (so it is read, not tapped).
 */
function fromDoc(reply: RegistryProfile, range: StatsRange, keyed: Map<string, number>): MemberProfile {
  const doc = reply.profile;
  const raw = (doc.ranges?.[range] ?? doc.ranges?.week ?? {}) as Record<string, unknown>;
  const idOf = (artist: unknown, title: unknown) =>
    typeof artist === 'string' && typeof title === 'string' ? (keyed.get(songKey(artist, title)) ?? -1) : -1;
  // A cover for an artist: any song of theirs this library holds.
  const coverFor = (artist: unknown) => {
    if (typeof artist !== 'string') return null;
    const prefix = `${fold(artist)}\u0000`;
    for (const [k, id] of keyed) if (k.startsWith(prefix)) return id;
    return null;
  };
  const topTracks = Array.isArray(raw.topTracks)
    ? raw.topTracks.map((t) => {
        const r = (t ?? {}) as Record<string, unknown>;
        return { ...r, trackId: idOf(r.artist, r.title) };
      })
    : [];
  const topArtists = Array.isArray(raw.topArtists)
    ? raw.topArtists.map((a) => {
        const r = (a ?? {}) as Record<string, unknown>;
        return { ...r, coverTrackId: coverFor(r.artist) };
      })
    : [];
  const favorites = (doc.favorites ?? [])
    .map((f) => keyed.get(songKey(f.artist, f.title)))
    .filter((id): id is number => typeof id === 'number');
  return {
    userId: 0,
    username: reply.handle,
    handle: reply.handle,
    memberSince: doc.memberSince ?? null,
    sharing: reply.sharing,
    stats: normalizeStatsSummary({ ...raw, range, topTracks, topArtists }, range),
    favorites,
    favoritesTotal: doc.favoritesTotal ?? favorites.length,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
  }
}

export function FriendProfilePage({
  friend,
  onBack,
  onPlay,
  onOpenArtist,
  onVisit,
}: {
  friend: RegistryFriend;
  onBack: () => void;
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
  onVisit?: (friend: RegistryFriend) => void;
}) {
  const t = useT();
  const { session } = useServerSession();
  const { tracks } = useLibrary();
  const [range, setRange] = useState<StatsRange>('week');
  const [profile, setProfile] = useState<MemberProfile | null>(null);
  const [face, setFace] = useState<'loading' | 'ok' | 'closed' | 'away' | 'unknown' | 'sorry'>('loading');
  /** What the server actually said when the profile did not load - shown
   *  rather than guessed at. "May be a version behind" was the old guess,
   *  and it was wrong on a hub that was two versions AHEAD. */
  const [reason, setReason] = useState<string | null>(null);

  const sameHub =
    !!session &&
    !!friend.serverUrl &&
    friend.serverUrl.replace(/\/+$/, '') === session.url.replace(/\/+$/, '');

  /*
   * Where the profile comes from - the REGISTRY first.
   *
   * A profile is a person's, not a server's: their app publishes it to
   * attack.fm from wherever they listen (listeningShare.tsx), and a friend
   * reads it from there on any hub. What arrives is names and numbers, so
   * the songs on it are resolved against THIS library by artist and title -
   * what you own plays, the rest is read. The hub's own profile route is the
   * fallback for a friend on your hub who has not published yet (an older
   * app), and the glance-only face is for everyone else.
   */
  const registry = useRegistryOptional();
  const registryToken = registry?.session?.token ?? null;
  const tz = new Date().getTimezoneOffset();
  useEffect(() => {
    let live = true;
    const fail = (err: unknown) => {
      if (!live) return;
      const text = err instanceof Error ? err.message : String(err ?? '');
      const status = err instanceof ServerError || err instanceof RegistryError ? err.status : 0;
      setReason(status ? `${status} · ${text}` : text || t('profile.friendNoReply'));
      // Matched against the HUB's own reply, which is English wherever the app
      // is set: this is the server's refusal, not a string of ours.
      setFace(text.includes('themselves') ? 'closed' : status === 404 ? 'unknown' : 'sorry');
    };
    const fromHub = () => {
      if (!sameHub || !session) {
        setFace('away');
        return;
      }
      fetchMemberProfile(session, friend.handle, range, tz)
        .then((p) => {
          if (!live) return;
          setProfile(p);
          setFace('ok');
        })
        .catch(fail);
    };
    // Keep the loaded page up while a new range loads under it; only the
    // first visit shows the skeleton state.
    setFace((f) => (f === 'ok' ? 'ok' : 'loading'));
    if (!registryToken) {
      fromHub();
      return () => {
        live = false;
      };
    }
    fetchRegistryProfile(registryToken, friend.handle)
      .then((r) => {
        if (!live) return;
        setProfile(fromDoc(r, range, keyed));
        setFace('ok');
      })
      .catch((err: unknown) => {
        if (!live) return;
        // Nothing published (an older app, or never shared): the hub may
        // still know them. A closed door or a real failure is final.
        if (err instanceof RegistryError && err.status === 404) fromHub();
        else fail(err);
      });
    return () => {
      live = false;
    };
    // `keyed` is left out on purpose: it changes with every library sync, and
    // a profile resolved against the library as it stood on arrival is
    // right enough - the next range tap resolves again.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed is left out on purpose: it changes with every library sync, and the profile stays resolved against the library as it stood on arrival
  }, [registryToken, sameHub, session, friend.handle, range]);

  // The shared library, keyed by server id - what turns her heart list and
  // her top songs into playable rows.
  const byId = useMemo(() => {
    const m = new Map<number, Track>();
    for (const t of tracksOfHub(tracks, session)) {
      const id = trackIdFromPath(t.path);
      if (id !== null) m.set(id, t);
    }
    return m;
    // `session` too: after a server switch this held the old hub's ids and
    // resolved her songs against the wrong library.
  }, [tracks, session]);

  // The same library by SONG - artist and title folded the way the hub's own
  // duplicate check folds them - for a profile that arrived as names. Only
  // this hub's rows: the ids handed back must resolve through `byId` above.
  const keyed = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of tracksOfHub(tracks, session)) {
      const id = trackIdFromPath(t.path);
      if (id === null) continue;
      const k = songKey(t.artist, t.title);
      if (!m.has(k)) m.set(k, id);
    }
    return m;
  }, [tracks, session]);

  const likedTracks = useMemo(
    () =>
      (profile?.favorites ?? [])
        .map((id) => byId.get(id))
        .filter((t): t is Track => t !== undefined),
    [profile, byId],
  );

  const albumArt = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tracks) {
      if (t.album && t.artwork && !m.has(t.album.toLowerCase())) m.set(t.album.toLowerCase(), t.artwork);
    }
    return m;
  }, [tracks]);

  const seen = friend.online ? t('profile.friendOnlineNow') : seenAgo(friend.seenAt);
  const host = hostOf(friend.serverUrl || (session?.url ?? ''));
  const idLine = [
    seen,
    sameHub
      ? t('profile.friendSameHub', { host })
      : friend.serverUrl
        ? t('profile.friendOtherHub', { host })
        : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const head = (
    <header className="friendProfile__head">
      <button type="button" className="friendProfile__back" aria-label={t('profile.friendBack')} onClick={onBack}>
        <ArrowLeft size={18} />
      </button>
      <FriendAvatar handle={friend.handle} size="lg" className="friendProfile__face" src={friend.avatarUrl} />
      <div className="friendProfile__who">
        <h2 className="friendProfile__handle">@{friend.handle}</h2>
        {idLine && <span className="friendProfile__sub">{idLine}</span>}
      </div>
      {onVisit && friend.serverUrl && !sameHub && (
        <Button variant="ghost" size="sm" onClick={() => onVisit(friend)}>
          <ArrowUpRight size={15} />
          {t('profile.friendVisitServer')}
        </Button>
      )}
    </header>
  );

  // ---- The three thin faces -----------------------------------------------

  if (face === 'away') {
    return (
      <div className="homePage friendProfile">
        {head}
        <FriendStats friend={friend} />
        <p className="statsNote">
          {t('profile.friendAwayNote', {
            handle: friend.handle,
            host: host || t('profile.friendUnknownHost'),
          })}
        </p>
      </div>
    );
  }
  if (face === 'closed') {
    return (
      <div className="homePage friendProfile">
        {head}
        <div className="friendProfile__closed">
          <Lock size={20} aria-hidden />
          <Text size="sm" tone="muted">
            {t('profile.friendClosedNote', { handle: friend.handle })}
          </Text>
        </div>
      </div>
    );
  }
  if (face === 'unknown') {
    return (
      <div className="homePage friendProfile">
        {head}
        <FriendStats friend={friend} />
        <p className="statsNote">
          {t('profile.friendNoMemberNote', {
            handle: friend.handle,
            host: host || t('profile.friendUnknownServer'),
          })}
        </p>
      </div>
    );
  }
  if (face === 'sorry' || !profile) {
    return (
      <div className="homePage friendProfile">
        {head}
        <p className="statsNote">
          {face === 'sorry'
            ? reason
              ? t('profile.friendLoadFailedReason', { reason })
              : t('profile.friendLoadFailed')
            : t('profile.friendLoading')}
        </p>
      </div>
    );
  }

  // ---- The full page ------------------------------------------------------

  const s = profile.stats;
  const topArtist = s.topArtists[0] ?? null;
  const topArtistCover =
    topArtist && topArtist.coverTrackId !== null
      ? (byId.get(topArtist.coverTrackId)?.artwork ?? null)
      : null;
  const topSong = s.topTracks[0] ?? null;
  const topSongTrack = topSong ? (byId.get(topSong.trackId) ?? null) : null;
  const topAlbum = s.topAlbums[0] ?? null;
  const topGenre = s.topGenres[0] ?? null;
  const genreSlug = topGenre ? genreArtwork(topGenre.genre) : null;
  const peakHour = s.clock.reduce(
    (best, v, i) => (v > (s.clock[best] ?? 0) ? i : best),
    s.clock.some((v) => v > 0) ? 0 : -1,
  );
  const likedShown = likedTracks.slice(0, LIKED_SHOWN);
  const artists = s.topArtists.slice(0, 5);
  const songs = s.topTracks.slice(0, 5);

  return (
    <div className="homePage friendProfile">
      {head}

      <div className="statsChips" role="tablist" aria-label={t('profile.statsRangeTabs')}>
        {RANGES.map((r) => (
          <button
            key={r.id}
            type="button"
            role="tab"
            aria-selected={range === r.id}
            className="statsChip"
            data-on={range === r.id ? '' : undefined}
            onClick={() => setRange(r.id)}
          >
            {t(r.labelKey)}
          </button>
        ))}
      </div>

      <section className="statsSection statsHero">
        <div className="statsHero__lead">
          <span className="statsHero__value">{fmtMinutes(s.minutes)}</span>
          <span className="statsHero__label">{t('profile.statsListened')}</span>
        </div>
        {/* formatNumber, not toLocaleString: the latter groups by the
            BROWSER's locale, which does not change with the app's. */}
        <div className="statsTiles">
          <StatTile icon={<Play size={16} />} value={formatNumber(s.plays)} label={t('profile.statsPlaysLabel', { count: s.plays })} edgeAccent />
          <StatTile icon={<Music size={16} />} value={formatNumber(s.uniqueTracks)} label={t('profile.statsUniqueTracks', { count: s.uniqueTracks })} />
          <StatTile icon={<User size={16} />} value={formatNumber(s.uniqueArtists)} label={t('profile.statsUniqueArtists', { count: s.uniqueArtists })} />
          <StatTile icon={<Flame size={16} />} value={formatNumber(s.streakDays)} label={t('profile.statsStreak', { count: s.streakDays })} />
        </div>
      </section>

      {(topArtist || topSong || topAlbum || topGenre || peakHour >= 0) && (
        <div className="statsArtChips">
          {topArtist && (
            <ArtChip
              label={t('profile.statsTopArtist')}
              value={topArtist.artist || t('common.unknownArtist')}
              artwork={topArtistCover}
              shape="circle"
              glyph={<User size={16} />}
              onClick={() => onOpenArtist(topArtist.artist)}
            />
          )}
          {topSong &&
            (topSongTrack ? (
              <TrackMenu track={topSongTrack}>
                <ArtChip
                  label={t('profile.statsOnRepeat')}
                  value={topSong.title || t('common.unknownSong')}
                  artwork={topSongTrack.artwork ?? null}
                  glyph={<Music size={16} />}
                  onClick={() => onPlay(topSongTrack, [topSongTrack])}
                />
              </TrackMenu>
            ) : (
              <ArtChip
                label={t('profile.statsOnRepeat')}
                value={topSong.title || t('common.unknownSong')}
                artwork={null}
                glyph={<Music size={16} />}
              />
            ))}
          {topAlbum && (
            <ArtChip
              label={t('profile.statsTopAlbum')}
              value={topAlbum.album || t('common.unknownAlbum')}
              artwork={albumArt.get(topAlbum.album.toLowerCase()) ?? null}
              glyph={<Disc3 size={16} />}
            />
          )}
          {topGenre && (
            <ArtChip
              label={t('profile.statsTopGenre')}
              value={topGenre.genre || t('common.unknownGenre')}
              artwork={genreSlug ? artworkUrl(genreSlug) : null}
              glyph={<Tag size={16} />}
              hue={genreSlug ? artworkHue(genreSlug) : null}
            />
          )}
          {peakHour >= 0 && <ArtChip
              label={t('profile.statsPeakHour')}
              value={fmtHour(peakHour)}
              glyph={<Clock size={16} />}
              hue={210}
            />}
        </div>
      )}

      <section className="statsSection">
        <Heading icon={<AudioWaveform size={14} />}>{t('profile.statsListeningHeading')}</Heading>
        <TimeSeriesChart
          times={s.byDay.map((d) => dayToLocalMs(d.day))}
          series={[
            {
              id: 'minutes',
              label: t('profile.statsMinutesSeries'),
              values: s.byDay.map((d) => d.minutes),
              tone: 'accent',
            },
          ]}
          shape="area"
          height="180px"
          formatValue={fmtAxisMinutes}
          formatTime={fmtDayMs}
          emptyLabel={t('profile.statsRangeEmpty')}
          aria-label={t('profile.friendChartLabel', { handle: friend.handle })}
        />
      </section>

      {likedShown.length > 0 && (
        <section className="statsSection">
          <Heading icon={<Heart size={14} />}>{t('profile.friendLikedHeading')}</Heading>
          <p className="friendProfile__count">
            {profile.favoritesTotal > likedShown.length
              ? t('profile.friendHeartedLatest', {
                  count: profile.favoritesTotal,
                  shown: likedShown.length,
                })
              : t('profile.friendHearted', { count: profile.favoritesTotal })}
          </p>
          <ol className="statsRows">
            {likedShown.map((liked) => (
              <TrackMenu key={liked.path} track={liked}>
                <li className="statsRow">
                  <span className="statsRow__rank friendProfile__heartRank" aria-hidden>
                    <Heart size={12} />
                  </span>
                  <RowArt artwork={liked.artwork ?? null} shape="square" glyph={<Music size={16} aria-hidden />} />
                  <span className="statsRow__body">
                    <button
                      type="button"
                      className="statsRow__name"
                      onClick={() => onPlay(liked, likedTracks)}
                    >
                      {liked.title}
                    </button>
                    <span className="statsRow__sub">
                      <ArtistLink artist={liked.artist} />
                    </span>
                  </span>
                </li>
              </TrackMenu>
            ))}
          </ol>
        </section>
      )}

      {artists.length > 0 && (
        <section className="statsSection">
          <Heading icon={<User size={14} />}>{t('profile.statsTopArtistsHeading')}</Heading>
          <ol className="statsRows">
            {artists.map((row, i) => {
              const cover = row.coverTrackId !== null ? (byId.get(row.coverTrackId)?.artwork ?? null) : null;
              return (
                <li key={`${row.artist}:${i}`} className="statsRow">
                  <span className="statsRow__rank">{i + 1}</span>
                  <RowArt artwork={cover} shape="circle" glyph={<User size={16} aria-hidden />} />
                  <span className="statsRow__body">
                    <button type="button" className="statsRow__name" onClick={() => onOpenArtist(row.artist)}>
                      {row.artist || t('common.unknownArtist')}
                    </button>
                  </span>
                  <span className="statsRow__meta">
                    {t('profile.statsPlayCount', { count: row.plays })} · {fmtMinutes(row.minutes)}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {songs.length > 0 && (
        <section className="statsSection">
          <Heading icon={<Music size={14} />}>{t('profile.statsTopSongsHeading')}</Heading>
          <ol className="statsRows">
            {songs.map((row, i) => {
              const mine = byId.get(row.trackId) ?? null;
              const body = (
                <li key={`${row.trackId}:${i}`} className="statsRow">
                  <span className="statsRow__rank">{i + 1}</span>
                  <RowArt artwork={mine?.artwork ?? null} shape="square" glyph={<Music size={16} aria-hidden />} />
                  <span className="statsRow__body">
                    {mine ? (
                      <button type="button" className="statsRow__name" onClick={() => onPlay(mine, [mine])}>
                        {row.title || mine.title}
                      </button>
                    ) : (
                      <span className="statsRow__name" data-plain>
                        {row.title || t('common.unknownSong')}
                      </span>
                    )}
                    <span className="statsRow__sub">
                      <ArtistLink artist={row.artist} />
                    </span>
                  </span>
                  <span className="statsRow__meta">
                    {t('profile.statsPlayCount', { count: row.plays })}
                  </span>
                </li>
              );
              return mine ? (
                <TrackMenu key={`${row.trackId}:${i}`} track={mine}>
                  {body}
                </TrackMenu>
              ) : (
                body
              );
            })}
          </ol>
        </section>
      )}

      <p className="statsNote">
        {sameHub ? t('profile.friendWhyVisibleSameHub') : t('profile.friendWhyVisibleRegistry')}{' '}
        {t('profile.friendCloseDoor', { handle: friend.handle })}
      </p>
    </div>
  );
}
