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
import { fmtMinutes, type StatsRange } from './stats.ts';
import { RANGES, dayToLocalMs, fmtAxisMinutes, fmtHour, MONTHS } from './statsFormat.ts';
import { ArtChip, Heading, RowArt } from './StatsBits.tsx';
import { FriendAvatar, FriendStats, seenAgo } from './RegistryFriends.tsx';
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

  useEffect(() => {
    if (!sameHub || !session) {
      setFace('away');
      return undefined;
    }
    let live = true;
    // Keep the loaded page up while a new range loads under it; only the
    // first visit shows the skeleton state.
    setFace((f) => (f === 'ok' ? 'ok' : 'loading'));
    fetchMemberProfile(session, friend.handle, range, new Date().getTimezoneOffset())
      .then((p) => {
        if (!live) return;
        setProfile(p);
        setFace('ok');
      })
      .catch((err: unknown) => {
        if (!live) return;
        const text = err instanceof Error ? err.message : String(err ?? '');
        const status = err instanceof ServerError ? err.status : 0;
        // 403 with the hub's own words: a closed door. 404: the hub has no
        // member under that handle - they are on it with a plain server
        // login the registry never tied to their account. Anything else is
        // a real failure, and the reason is shown.
        setReason(status ? `${status} · ${text}` : text || 'no reply');
        setFace(text.includes('themselves') ? 'closed' : status === 404 ? 'unknown' : 'sorry');
      });
    return () => {
      live = false;
    };
  }, [sameHub, session, friend.handle, range]);

  // The shared library, keyed by server id - what turns her heart list and
  // her top songs into playable rows.
  const byId = useMemo(() => {
    const m = new Map<number, Track>();
    for (const t of tracksOfHub(tracks, session)) {
      const id = trackIdFromPath(t.path);
      if (id !== null) m.set(id, t);
    }
    return m;
  }, [tracks]);

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

  const seen = seenAgo(friend.seenAt);
  const host = hostOf(friend.serverUrl || (session?.url ?? ''));
  const idLine = [
    seen,
    sameHub ? `with you on ${host}` : friend.serverUrl ? `lives on ${host}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const head = (
    <header className="friendProfile__head">
      <button type="button" className="friendProfile__back" aria-label="Back to friends" onClick={onBack}>
        <ArrowLeft size={18} />
      </button>
      <FriendAvatar handle={friend.handle} size="lg" className="friendProfile__face" />
      <div className="friendProfile__who">
        <h2 className="friendProfile__handle">@{friend.handle}</h2>
        {idLine && <span className="friendProfile__sub">{idLine}</span>}
      </div>
      {onVisit && friend.serverUrl && !sameHub && (
        <Button variant="ghost" size="sm" onClick={() => onVisit(friend)}>
          <ArrowUpRight size={15} />
          Visit their server
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
          {friend.handle} listens from {host || 'their own server'}. Across servers, friends share
          the week&rsquo;s glance - minutes, top artist, streak - and nothing more.
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
            {friend.handle} keeps their listening to themselves.
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
          {host || 'That server'} has no member under @{friend.handle}. They are on it with a
          server login the registry never tied to their AttackFM account - once they sign into
          it with the account (Profile → Where you listen), their profile appears here.
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
            ? `Their profile did not load${reason ? ` (${reason})` : ''}.`
            : 'Reading their listening…'}
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

      <div className="statsChips" role="tablist" aria-label="Time range">
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
            {r.label}
          </button>
        ))}
      </div>

      <section className="statsSection statsHero">
        <div className="statsHero__lead">
          <span className="statsHero__value">{fmtMinutes(s.minutes)}</span>
          <span className="statsHero__label">listened</span>
        </div>
        <div className="statsTiles">
          <StatTile icon={<Play size={16} />} value={s.plays.toLocaleString()} label="plays" edgeAccent />
          <StatTile icon={<Music size={16} />} value={s.uniqueTracks.toLocaleString()} label="different songs" />
          <StatTile icon={<User size={16} />} value={s.uniqueArtists.toLocaleString()} label="different artists" />
          <StatTile icon={<Flame size={16} />} value={s.streakDays.toLocaleString()} label="day streak" />
        </div>
      </section>

      {(topArtist || topSong || topAlbum || topGenre || peakHour >= 0) && (
        <div className="statsArtChips">
          {topArtist && (
            <ArtChip
              label="Top artist"
              value={topArtist.artist || 'Unknown artist'}
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
                  label="On repeat"
                  value={topSong.title || 'Unknown song'}
                  artwork={topSongTrack.artwork ?? null}
                  glyph={<Music size={16} />}
                  onClick={() => onPlay(topSongTrack, [topSongTrack])}
                />
              </TrackMenu>
            ) : (
              <ArtChip label="On repeat" value={topSong.title || 'Unknown song'} artwork={null} glyph={<Music size={16} />} />
            ))}
          {topAlbum && (
            <ArtChip
              label="Top album"
              value={topAlbum.album || 'Unknown album'}
              artwork={albumArt.get(topAlbum.album.toLowerCase()) ?? null}
              glyph={<Disc3 size={16} />}
            />
          )}
          {topGenre && (
            <ArtChip
              label="Top genre"
              value={topGenre.genre || 'Unknown'}
              artwork={genreSlug ? artworkUrl(genreSlug) : null}
              glyph={<Tag size={16} />}
              hue={genreSlug ? artworkHue(genreSlug) : null}
            />
          )}
          {peakHour >= 0 && <ArtChip label="Peak hour" value={fmtHour(peakHour)} glyph={<Clock size={16} />} hue={210} />}
        </div>
      )}

      <section className="statsSection">
        <Heading icon={<AudioWaveform size={14} />}>Listening</Heading>
        <TimeSeriesChart
          times={s.byDay.map((d) => dayToLocalMs(d.day))}
          series={[{ id: 'minutes', label: 'Minutes', values: s.byDay.map((d) => d.minutes), tone: 'accent' }]}
          shape="area"
          height="180px"
          formatValue={fmtAxisMinutes}
          formatTime={(t) => {
            const d = new Date(t);
            return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
          }}
          emptyLabel="Nothing yet for this range."
          aria-label={`Minutes ${friend.handle} listened per day`}
        />
      </section>

      {likedShown.length > 0 && (
        <section className="statsSection">
          <Heading icon={<Heart size={14} />}>Liked songs</Heading>
          <p className="friendProfile__count">
            {profile.favoritesTotal.toLocaleString()} {profile.favoritesTotal === 1 ? 'song' : 'songs'} hearted
            {profile.favoritesTotal > likedShown.length ? ` · the latest ${likedShown.length}` : ''}
          </p>
          <ol className="statsRows">
            {likedShown.map((t) => (
              <TrackMenu key={t.path} track={t}>
                <li className="statsRow">
                  <span className="statsRow__rank friendProfile__heartRank" aria-hidden>
                    <Heart size={12} />
                  </span>
                  <RowArt artwork={t.artwork ?? null} shape="square" glyph={<Music size={16} aria-hidden />} />
                  <span className="statsRow__body">
                    <button type="button" className="statsRow__name" onClick={() => onPlay(t, likedTracks)}>
                      {t.title}
                    </button>
                    <span className="statsRow__sub">
                      <ArtistLink artist={t.artist} />
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
          <Heading icon={<User size={14} />}>Top artists</Heading>
          <ol className="statsRows">
            {artists.map((row, i) => {
              const cover = row.coverTrackId !== null ? (byId.get(row.coverTrackId)?.artwork ?? null) : null;
              return (
                <li key={`${row.artist}:${i}`} className="statsRow">
                  <span className="statsRow__rank">{i + 1}</span>
                  <RowArt artwork={cover} shape="circle" glyph={<User size={16} aria-hidden />} />
                  <span className="statsRow__body">
                    <button type="button" className="statsRow__name" onClick={() => onOpenArtist(row.artist)}>
                      {row.artist || 'Unknown artist'}
                    </button>
                  </span>
                  <span className="statsRow__meta">
                    {row.plays.toLocaleString()} {row.plays === 1 ? 'play' : 'plays'} · {fmtMinutes(row.minutes)}
                  </span>
                </li>
              );
            })}
          </ol>
        </section>
      )}

      {songs.length > 0 && (
        <section className="statsSection">
          <Heading icon={<Music size={14} />}>Top songs</Heading>
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
                        {row.title || 'Unknown song'}
                      </span>
                    )}
                    <span className="statsRow__sub">
                      <ArtistLink artist={row.artist} />
                    </span>
                  </span>
                  <span className="statsRow__meta">
                    {row.plays.toLocaleString()} {row.plays === 1 ? 'play' : 'plays'}
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
        You can see all this because you share a server. {friend.handle} can close the door any time
        in Settings.
      </p>
    </div>
  );
}
