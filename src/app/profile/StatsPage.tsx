import { ArtistLink } from '../ux/ArtistLink.tsx';
import { TrackMenu } from '../library/TrackMenu.tsx';
import {
  AudioWaveform,
  ChevronDown,
  ChevronUp,
  Clock,
  Disc3,
  Flame,
  Music,
  Play,
  Tag,
  User,
} from '@glacier/icons';
import { useEffect, useMemo, useState } from 'react';
import { useRefreshNonce } from '../nav/pageRefresh.tsx';
import { useLibrary } from '../library/library.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { Button, StatTile, TimeSeriesChart } from '@glacier/react';
import { trackIdFromPath } from '../server.ts';
import { artworkHue, artworkUrl, genreArtwork } from '../ux/artwork.ts';
import {
  fetchStatsSummary,
  fmtMinutes,
  type StatsRange,
  type StatsSummary,
} from './stats.ts';
import type { Track } from '../core/tauri.ts';
import {
  AXIS_HOURS,
  MONTHS,
  RANGES,
  dayToLocalMs,
  fmtAxisMinutes,
  fmtHour,
} from './statsFormat.ts';
import { ArtChip, GENRE_TONES, Heading, RowArt } from './StatsBits.tsx';
import { StatsMore } from './StatsMore.tsx';
import { FriendsThisWeek } from './FriendsThisWeek.tsx';
import './StatsPage.css';
import { tracksOfHub } from '../server.ts';

/**
 * Your listening, in numbers.
 *
 * The server keeps the listen log (see listens.ts for what counts as a
 * listen); this page asks it for one summary per range and draws that reply
 * as it stands - no client-side aggregation, because the log lives on the
 * box and a phone that synced yesterday should not be computing a different
 * truth than the desktop.
 *
 * The page opens with the story - a headline, the leaders wearing their own
 * album art, a real chart of the days - and keeps the census behind a "More
 * stats" fold: rates, genres, albums, the sound profile, a year in squares.
 * Everything renders from a normalised summary (stats.ts), so a missing or
 * partial field is an empty section here, never a crash.
 *
 * Split across siblings: formatters in statsFormat.ts, presentational atoms
 * in StatsBits.tsx, the fold's content in StatsMore.tsx, the friends
 * leaderboard in FriendsThisWeek.tsx.
 */

export function StatsPage({
  onPlay,
  onOpenArtist,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
}) {
  const { session } = useServerSession();
  // Pull-to-refresh re-runs the fetch below - see nav/pageRefresh.tsx.
  const refreshNonce = useRefreshNonce();
  const { tracks } = useLibrary();
  const [range, setRange] = useState<StatsRange>('week');
  const [summary, setSummary] = useState<StatsSummary | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [more, setMore] = useState(false);
  // The year of squares needs a year of days whatever the chips show; fetched
  // once, on the first unfold, and kept.
  const [yearDays, setYearDays] = useState<StatsSummary['byDay'] | null>(null);

  useEffect(() => {
    if (!session) return;
    setState('loading');
    const ctrl = new AbortController();
    void fetchStatsSummary(session, range, ctrl.signal)
      .then((s) => {
        setSummary(s);
        setState('ready');
        if (range === 'year') setYearDays(s.byDay);
      })
      .catch(() => {
        // An older server without the endpoint, or no network. A switched
        // range aborts the old fetch, and an abort is not an error state.
        if (!ctrl.signal.aborted) setState('error');
      });
    return () => ctrl.abort();
  }, [session, range, refreshNonce]);

  useEffect(() => {
    if (!more || yearDays !== null || !session) return;
    const ctrl = new AbortController();
    void fetchStatsSummary(session, 'year', ctrl.signal)
      .then((s) => setYearDays(s.byDay))
      .catch(() => {
        // The fold simply opens without the heatmap.
      });
    return () => ctrl.abort();
  }, [more, yearDays, session, refreshNonce]);

  // The summary names tracks by server id; artwork lives on the synced
  // library's Track rows. One map bridges them for every cover on the page.
  const byId = useMemo(() => {
    const map = new Map<number, Track>();
    for (const t of tracksOfHub(tracks, session)) {
      const id = trackIdFromPath(t.path);
      if (id !== null) map.set(id, t);
    }
    return map;
  }, [tracks]);

  // Albums arrive as name strings only, so their covers are joined here: the
  // first track in the library wearing that album name lends its art. A name
  // collision across two artists hands the wrong cover to a rare row, which
  // is the acceptable end of that trade.
  const albumArt = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tracks) {
      if (!t.artwork || !t.album) continue;
      const key = t.album.toLowerCase();
      if (!map.has(key)) map.set(key, t.artwork);
    }
    return map;
  }, [tracks]);

  if (!session) {
    return (
      <div className="homePage statsPage">
        <p className="statsNote">Stats live on your server — connect to one.</p>
      </div>
    );
  }

  const chips = (
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
  );

  if (state === 'loading' || (state === 'ready' && !summary)) {
    return (
      <div className="homePage statsPage">
        {chips}
        <div className="statsHero" data-ghost aria-hidden />
        <div className="statsTiles" aria-hidden>
          {Array.from({ length: 4 }, (_, i) => (
            <StatTile key={i} skeleton value="" label="" />
          ))}
        </div>
        <TimeSeriesChart skeleton times={[]} series={[]} height="180px" aria-label="Loading" />
      </div>
    );
  }

  if (state === 'error' || !summary) {
    return (
      <div className="homePage statsPage">
        {chips}
        <p className="statsNote">
          This server does not track listening yet — it needs the current home-hub build.
        </p>
      </div>
    );
  }

  // Fresh tracking: the endpoint answers, the ledger is just empty.
  if (summary.minutes === 0 && summary.plays === 0) {
    return (
      <div className="homePage statsPage">
        {chips}
        <p className="statsNote">Nothing counted yet — stats start with your next listen.</p>
      </div>
    );
  }

  const clockMax = Math.max(...summary.clock);
  const peakHour = clockMax > 0 ? summary.clock.indexOf(clockMax) : -1;

  const artists = summary.topArtists.slice(0, 10);
  const songs = summary.topTracks.slice(0, 10);
  const albums = summary.topAlbums.slice(0, 8);
  const genres = summary.topGenres.slice(0, 8);

  const topArtist = artists[0] ?? null;
  const topArtistCover =
    topArtist && topArtist.coverTrackId !== null
      ? (byId.get(topArtist.coverTrackId)?.artwork ?? null)
      : null;
  const topSong = songs[0] ?? null;
  const topSongTrack = topSong ? (byId.get(topSong.trackId) ?? null) : null;
  const topAlbum = albums[0] ?? null;
  const topGenre = genres[0] ?? null;
  const genreSlug = topGenre ? genreArtwork(topGenre.genre) : null;

  // One chart from the day bars: local-midnight timestamps, minutes as the
  // one series. The kit draws the axis, the readout and the empty face.
  const chartTimes = summary.byDay.map((d) => dayToLocalMs(d.day));
  const chartValues = summary.byDay.map((d) => d.minutes);

  const genreTotal = genres.reduce((n, g) => n + g.minutes, 0);
  const genreSegments = genres.slice(0, GENRE_TONES.length).map((g, i) => ({
    value: g.minutes,
    tone: GENRE_TONES[i],
    label: g.genre || 'Unknown',
  }));
  const genreRest = genres.slice(GENRE_TONES.length).reduce((n, g) => n + g.minutes, 0);
  if (genreRest > 0) genreSegments.push({ value: genreRest, tone: 'neutral', label: 'Everything else' });

  return (
    <div className="homePage statsPage">
      {chips}

      {/* The headline: how much, said once and large, with the shape of the
          days beside it and the census in tiles underneath. */}
      <section className="statsSection">
        <div className="statsHero">
          <div className="statsHero__head">
            <span className="statsHero__value">{fmtMinutes(summary.minutes)}</span>
            <span className="statsHero__label">
              listened {RANGES.find((r) => r.id === range)?.label.toLowerCase()}
            </span>
          </div>
          {summary.firstListens > 0 && (
            <p className="statsFirsts">
              {summary.firstListens.toLocaleString()}{' '}
              {summary.firstListens === 1 ? 'song' : 'songs'} you&rsquo;d never played before
            </p>
          )}
        </div>
        <div className="statsTiles">
          <StatTile
            icon={<Play size={16} />}
            value={summary.plays.toLocaleString()}
            label="plays"
            edgeAccent
          />
          <StatTile
            icon={<Music size={16} />}
            value={summary.uniqueTracks.toLocaleString()}
            label="different songs"
          />
          <StatTile
            icon={<User size={16} />}
            value={summary.uniqueArtists.toLocaleString()}
            label="different artists"
          />
          <StatTile
            icon={<Flame size={16} />}
            value={summary.streakDays.toLocaleString()}
            label={summary.streakDays === 1 ? 'day streak' : 'day streak'}
          />
        </div>
      </section>

      {/* The leaders, wearing their own covers. */}
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
            // The one leader chip that is a SONG wears a song's menu - the
            // others open pages, whose verbs live on those pages.
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
              <ArtChip
                label="On repeat"
                value={topSong.title || 'Unknown song'}
                artwork={null}
                glyph={<Music size={16} />}
              />
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
          {peakHour >= 0 && (
            <ArtChip
              label="Peak hour"
              value={fmtHour(peakHour)}
              glyph={<Clock size={16} />}
              hue={210}
            />
          )}
        </div>
      )}

      <section className="statsSection">
        <Heading icon={<AudioWaveform size={14} />}>Listening</Heading>
        <TimeSeriesChart
          times={chartTimes}
          series={[{ id: 'minutes', label: 'Minutes', values: chartValues, tone: 'accent' }]}
          shape="area"
          height="180px"
          formatValue={fmtAxisMinutes}
          formatTime={(t) => {
            const d = new Date(t);
            return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
          }}
          emptyLabel="Nothing yet for this range."
          aria-label="Minutes listened per day"
        />
      </section>

      <section className="statsSection">
        <Heading icon={<Clock size={14} />}>Your clock</Heading>
        {clockMax === 0 ? (
          <p className="statsQuiet">Nothing yet — the clock fills in as you listen.</p>
        ) : (
          <div
            className="statsClock"
            role="img"
            aria-label={`Listening by hour of day, busiest around ${fmtHour(peakHour)}`}
          >
            {summary.clock.map((minutes, hour) => (
              <div
                key={hour}
                className="statsClock__col"
                title={`${fmtHour(hour)} — ${Math.round(minutes)} min`}
              >
                {hour === peakHour && (
                  <span className="statsClock__peak" aria-hidden>
                    {fmtHour(hour)}
                  </span>
                )}
                <span className="statsClock__rail" aria-hidden>
                  {minutes > 0 && (
                    <span
                      className="statsClock__fill"
                      style={{ blockSize: `${(minutes / clockMax) * 100}%` }}
                    />
                  )}
                </span>
                <span className="statsClock__hour" aria-hidden>
                  {AXIS_HOURS.has(hour) ? fmtHour(hour) : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      {artists.length > 0 && (
        <section className="statsSection">
          <Heading icon={<User size={14} />}>Top artists</Heading>
          <ol className="statsRows">
            {artists.map((row, i) => {
              const cover =
                row.coverTrackId !== null ? (byId.get(row.coverTrackId)?.artwork ?? null) : null;
              return (
                <li key={`${row.artist}:${i}`} className="statsRow">
                  <span className="statsRow__rank">{i + 1}</span>
                  <RowArt artwork={cover} shape="circle" glyph={<User size={16} aria-hidden />} />
                  <span className="statsRow__body">
                    <button
                      type="button"
                      className="statsRow__name"
                      onClick={() => onOpenArtist(row.artist)}
                    >
                      {row.artist || 'Unknown artist'}
                    </button>
                  </span>
                  <span className="statsRow__meta">
                    {row.plays.toLocaleString()} {row.plays === 1 ? 'play' : 'plays'} ·{' '}
                    {fmtMinutes(row.minutes)}
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
              // The song may have left the library since it was played; the
              // row still tells its story, it just stops being a play button.
              const mine = byId.get(row.trackId) ?? null;
              const body = (
                <li key={`${row.trackId}:${i}`} className="statsRow">
                  <span className="statsRow__rank">{i + 1}</span>
                  <RowArt artwork={mine?.artwork ?? null} shape="square" glyph={<Music size={16} aria-hidden />} />
                  <span className="statsRow__body">
                    {mine ? (
                      <button
                        type="button"
                        className="statsRow__name"
                        onClick={() => onPlay(mine, [mine])}
                      >
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
              // A row whose song is still in the library is a song row like
              // any other, so it wears the same menu; one whose song has left
              // has nothing for the verbs to act on.
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

      {/* The fold. Everything above is the story; everything below is the
          census, and someone has to ask for a census. */}
      <div className="statsMore">
        <Button variant="soft" onClick={() => setMore((v) => !v)} aria-expanded={more}>
          {more ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          {more ? 'Fewer stats' : 'View more stats'}
        </Button>
      </div>

      {more && (
        <StatsMore
          summary={summary}
          genreSegments={genreSegments}
          genreTotal={genreTotal}
          albumArt={albumArt}
          yearDays={yearDays}
        />
      )}

      <FriendsThisWeek myMinutes={range === 'week' ? summary.minutes : null} myStreak={range === 'week' ? summary.streakDays : null} />
    </div>
  );
}
