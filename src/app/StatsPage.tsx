import {
  Users,
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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import {
  Button,
  Heatmap,
  ProgressRing,
  SegmentedBar,
  StatTile,
  Switch,
  TimeSeriesChart,
} from '@glacier/react';
import { useRegistry } from './registrySession.tsx';
import { fetchFriends, type RegistryFriend } from './registry.ts';
import { setSharing, useSharing } from './listeningShare.tsx';
import { artSized, trackIdFromPath } from './server.ts';
import { useArtLoad } from './artLoad.ts';
import { artworkHue, artworkUrl, genreArtwork } from './artwork.ts';
import {
  fetchStatsSummary,
  fmtMinutes,
  clamp01,
  type StatsRange,
  type StatsSummary,
} from './stats.ts';
import type { Track } from './tauri.ts';
import './StatsPage.css';

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
 */

const RANGES: { id: StatsRange; label: string }[] = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
];

/** The hours the clock's axis names. Four is enough to orient by. */
const AXIS_HOURS = new Set([0, 6, 12, 18]);

/** An hour as people say it: 0 → "12a", 14 → "2p". */
function fmtHour(hour: number): string {
  if (hour === 0) return '12a';
  if (hour < 12) return `${hour}a`;
  if (hour === 12) return '12p';
  return `${hour - 12}p`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-08-11" → "Aug 11". Split by hand: `new Date` on a bare date string
 *  parses it as UTC midnight, which shifts the label a day west of Greenwich. */
function fmtDay(day: string): string {
  const [, m, d] = day.split('-');
  const month = MONTHS[Number(m) - 1];
  return month ? `${month} ${Number(d)}` : day;
}

/** "2026-08-11" → local epoch ms, for the chart's time axis. Same hand-split,
 *  same reason: the constructor's string parse would land at UTC midnight. */
function dayToLocalMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1).getTime();
}

/** Chart-axis minutes: whole hours once the numbers are big. */
function fmtAxisMinutes(v: number): string {
  if (v >= 120) return `${Math.round(v / 60)}h`;
  return `${Math.round(v)}m`;
}

/** A section heading in the search page's idiom: glyph, then the words. */
function Heading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <h2 className="statsSection__title">
      <span className="statsSection__glyph" aria-hidden>
        {icon}
      </span>
      {children}
    </h2>
  );
}

/** A rank row's cover. The rows render inside maps, where hooks cannot live,
 *  so the art - skeleton, pop, and the 160 thumb variant - keeps a component
 *  of its own. The fallback glyph is the caller's: a person for artists, a
 *  note for songs. */
function RowArt({
  artwork,
  shape,
  glyph,
}: {
  artwork: string | null;
  shape: 'circle' | 'square';
  glyph: ReactNode;
}) {
  const src = artSized(artwork, 160);
  const art = useArtLoad(src, '');
  return (
    <span className="statsRow__art" data-shape={shape}>
      {artwork ? <img {...art} src={src ?? undefined} alt="" loading="lazy" /> : glyph}
    </span>
  );
}

/**
 * A fact wearing its own cover: the label chip this page leads with.
 *
 * The art is the point - "top artist" lands differently when it is their face
 * on the chip - so the cover takes the leading slot and the words ride beside
 * it. Chips whose subject has no cover (peak hour, streak) wear a glyph on a
 * hue instead, so the row still reads as one family. A chip with somewhere to
 * go (an artist page, a play) is a button; the rest are labels.
 */
function ArtChip({
  label,
  value,
  artwork,
  shape = 'square',
  glyph,
  hue,
  onClick,
}: {
  label: string;
  value: string;
  artwork?: string | null;
  shape?: 'circle' | 'square';
  glyph?: ReactNode;
  /** Backdrop hue for glyph chips, from the generated-art family. */
  hue?: number | null;
  onClick?: () => void;
}) {
  const src = artSized(artwork ?? null, 160);
  const art = useArtLoad(src, '');
  const body = (
    <>
      <span
        className="statsArtChip__art"
        data-shape={shape}
        style={hue != null ? ({ '--chip-hue': String(hue) } as React.CSSProperties) : undefined}
        aria-hidden
      >
        {artwork ? <img {...art} src={src ?? undefined} alt="" loading="lazy" /> : glyph}
      </span>
      <span className="statsArtChip__text">
        <span className="statsArtChip__label">{label}</span>
        <span className="statsArtChip__value">{value}</span>
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className="statsArtChip" onClick={onClick}>
      {body}
    </button>
  ) : (
    <span className="statsArtChip">{body}</span>
  );
}

/** A labelled 0..1 fill - the sound profile wears these. */
function SoundMeter({ label, value }: { label: string; value: number }) {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div className="statsMeter">
      <span className="statsMeter__label">
        {label} {pct}%
      </span>
      <span className="statsMeter__rail" aria-hidden>
        <span className="statsMeter__fill" style={{ inlineSize: `${pct}%` }} />
      </span>
    </div>
  );
}

/** The inks the genre bar cycles through, and the same list the legend dots
 *  read, so the two cannot disagree. */
const GENRE_TONES = ['accent', 'success', 'warning', 'danger', 'neutral'] as const;
const GENRE_DOT: Record<(typeof GENRE_TONES)[number], string> = {
  accent: 'var(--glacier-accent-solid)',
  success: 'var(--glacier-success-solid)',
  warning: 'var(--glacier-warning-solid)',
  danger: 'var(--glacier-danger-solid)',
  neutral: 'var(--glacier-border)',
};

export function StatsPage({
  onPlay,
  onOpenArtist,
}: {
  onPlay: (track: Track, queue: Track[]) => void;
  onOpenArtist: (artist: string) => void;
}) {
  const { session } = useServerSession();
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
  }, [session, range]);

  useEffect(() => {
    if (!more || yearDays !== null || !session) return;
    const ctrl = new AbortController();
    void fetchStatsSummary(session, 'year', ctrl.signal)
      .then((s) => setYearDays(s.byDay))
      .catch(() => {
        // The fold simply opens without the heatmap.
      });
    return () => ctrl.abort();
  }, [more, yearDays, session]);

  // The summary names tracks by server id; artwork lives on the synced
  // library's Track rows. One map bridges them for every cover on the page.
  const byId = useMemo(() => {
    const map = new Map<number, Track>();
    for (const t of tracks) {
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
          {topSong && (
            <ArtChip
              label="On repeat"
              value={topSong.title || 'Unknown song'}
              artwork={topSongTrack?.artwork ?? null}
              glyph={<Music size={16} />}
              onClick={topSongTrack ? () => onPlay(topSongTrack, [topSongTrack]) : undefined}
            />
          )}
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
              return (
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
                    <span className="statsRow__sub">{row.artist}</span>
                  </span>
                  <span className="statsRow__meta">
                    {row.plays.toLocaleString()} {row.plays === 1 ? 'play' : 'plays'}
                  </span>
                </li>
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
        <>
          <section className="statsSection">
            <Heading icon={<Play size={14} />}>How you listen</Heading>
            <div className="statsRings">
              <div className="statsRing">
                <ProgressRing
                  value={Math.round(clamp01(summary.completionRate) * 100)}
                  max={100}
                  size={76}
                  thickness={8}
                  tone="accent"
                  showValue
                  aria-label="Songs finished"
                />
                <span className="statsRing__label">finished</span>
              </div>
              <div className="statsRing">
                <ProgressRing
                  value={Math.round(clamp01(summary.skipRate) * 100)}
                  max={100}
                  size={76}
                  thickness={8}
                  tone="warning"
                  showValue
                  aria-label="Songs skipped"
                />
                <span className="statsRing__label">skipped</span>
              </div>
              <div className="statsRing" data-wide>
                <span className="statsRing__big">{summary.firstListens.toLocaleString()}</span>
                <span className="statsRing__label">
                  {summary.firstListens === 1 ? 'song' : 'songs'} new to you
                </span>
              </div>
            </div>
          </section>

          {genres.length > 0 && (
            <section className="statsSection">
              <Heading icon={<Tag size={14} />}>Genres</Heading>
              <SegmentedBar data={genreSegments} size="md" rounded aria-label="Listening by genre" />
              <ol className="statsSmallRows">
                {genreSegments.map((seg, i) => (
                  <li key={`${seg.label}:${i}`} className="statsSmallRow">
                    <span className="statsSmallRow__body" data-dotted>
                      <span
                        className="statsGenreDot"
                        style={{ background: GENRE_DOT[seg.tone as keyof typeof GENRE_DOT] }}
                        aria-hidden
                      />
                      <span className="statsSmallRow__name">{seg.label}</span>
                    </span>
                    <span className="statsSmallRow__meta">
                      {genreTotal > 0 ? `${Math.round((seg.value / genreTotal) * 100)}%` : ''} ·{' '}
                      {fmtMinutes(seg.value)}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {albums.length > 0 && (
            <section className="statsSection">
              <Heading icon={<Disc3 size={14} />}>Top albums</Heading>
              <ol className="statsRows">
                {albums.map((row, i) => (
                  <li key={`${row.album}:${row.artist}:${i}`} className="statsRow">
                    <span className="statsRow__rank">{i + 1}</span>
                    <RowArt
                      artwork={albumArt.get(row.album.toLowerCase()) ?? null}
                      shape="square"
                      glyph={<Disc3 size={16} aria-hidden />}
                    />
                    <span className="statsRow__body">
                      <span className="statsRow__name" data-plain>
                        {row.album || 'Unknown album'}
                      </span>
                      <span className="statsRow__sub">{row.artist}</span>
                    </span>
                    <span className="statsRow__meta">
                      {row.plays.toLocaleString()} {row.plays === 1 ? 'play' : 'plays'}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {summary.sound && (
            <section className="statsSection">
              <Heading icon={<AudioWaveform size={14} />}>Your sound</Heading>
              <div className="statsSound">
                <div className="statsTempo">
                  <span className="statsTempo__value">{Math.round(summary.sound.bpm)}</span>
                  <span className="statsTempo__label">BPM</span>
                </div>
                <SoundMeter label="Energy" value={summary.sound.energy} />
                <SoundMeter label="Brightness" value={summary.sound.brightness} />
              </div>
            </section>
          )}

          {yearDays && yearDays.some((d) => d.minutes > 0) && (
            <section className="statsSection">
              <Heading icon={<Flame size={14} />}>A year of listening</Heading>
              <div className="statsHeat">
                <Heatmap
                  data={yearDays.map((d) => ({ date: fmtDay(d.day), value: d.minutes }))}
                  rows={7}
                  legend
                  aria-label="Minutes listened per day over the last year"
                />
              </div>
            </section>
          )}
        </>
      )}

      <FriendsThisWeek myMinutes={range === 'week' ? summary.minutes : null} myStreak={range === 'week' ? summary.streakDays : null} />
    </div>
  );
}

/**
 * The leaderboard, such as it is: your week beside the friends who share
 * theirs. Strictly opt-in both ways - the switch here controls whether YOUR
 * numbers go out (see listeningShare.tsx for how off = silence), and a friend
 * with the switch off simply has no row. No registry identity, no section.
 */
function FriendsThisWeek({
  myMinutes,
  myStreak,
}: {
  /** Passed through when the page already holds the week summary; fetched
   *  quietly otherwise so the card is per-week whatever the chips show. */
  myMinutes: number | null;
  myStreak: number | null;
}) {
  const { session: registry } = useRegistry();
  const { session: server } = useServerSession();
  const sharing = useSharing();
  const [friends, setFriends] = useState<RegistryFriend[]>([]);
  const [week, setWeek] = useState<{ minutes: number; streak: number } | null>(
    myMinutes === null ? null : { minutes: myMinutes, streak: myStreak ?? 0 },
  );

  useEffect(() => {
    if (myMinutes !== null) {
      setWeek({ minutes: myMinutes, streak: myStreak ?? 0 });
      return;
    }
    if (!server) return;
    const ctrl = new AbortController();
    void fetchStatsSummary(server, 'week', ctrl.signal)
      .then((s) => setWeek({ minutes: s.minutes, streak: s.streakDays }))
      .catch(() => {});
    return () => ctrl.abort();
  }, [myMinutes, myStreak, server]);

  useEffect(() => {
    if (!registry) return;
    let live = true;
    void fetchFriends(registry.token)
      .then((feed) => live && setFriends(feed.friends))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [registry, sharing]);

  if (!registry) return null;

  const sharers = friends
    .filter((f) => typeof f.weekMinutes === 'number')
    .sort((a, b) => (b.weekMinutes ?? 0) - (a.weekMinutes ?? 0));
  const rows: { who: string; minutes: number; streak: number | null; top: string | null; me: boolean }[] = [
    ...(sharing && week
      ? [{ who: 'You', minutes: week.minutes, streak: week.streak, top: null, me: true }]
      : []),
    ...sharers.map((f) => ({
      who: `@${f.handle}`,
      minutes: f.weekMinutes ?? 0,
      streak: f.streakDays ?? null,
      top: f.weekTopArtist ?? null,
      me: false,
    })),
  ].sort((a, b) => b.minutes - a.minutes);
  const most = rows[0]?.minutes ?? 0;

  return (
    <section className="statsSection">
      <Heading icon={<Users size={14} />}>Friends this week</Heading>
      <Switch
        label="Share my listening with friends"
        checked={sharing}
        onCheckedChange={setSharing}
      />
      <p className="statsFriendsNote">
        {sharing
          ? 'Sharing minutes, streak and top artist — nothing more. Switch off and it fades from friends within the week.'
          : 'Off: your numbers stay home. Friends who share still show below.'}
      </p>
      {rows.length === 0 ? (
        <p className="statsFriendsNote">
          {friends.length === 0
            ? 'No friends on the registry yet.'
            : 'None of your friends share their listening yet.'}
        </p>
      ) : (
        <ol className="statsFriends">
          {rows.map((row) => (
            <li key={row.who} className="statsFriendRow" data-me={row.me || undefined}>
              <span className="statsFriendRow__who">{row.who}</span>
              <span className="statsFriendRow__rail" aria-hidden>
                <span
                  className="statsFriendRow__fill"
                  style={{ inlineSize: most > 0 ? `${(row.minutes / most) * 100}%` : '0%' }}
                />
              </span>
              <span className="statsFriendRow__meta">
                {fmtMinutes(row.minutes)}
                {row.streak != null && row.streak > 1 && ` · ${row.streak}d streak`}
                {row.top && ` · ${row.top}`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
