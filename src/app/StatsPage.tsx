import {
  AudioWaveform,
  CalendarDays,
  Clock,
  Disc3,
  Flame,
  Music,
  Play,
  SkipForward,
  Tag,
  User,
} from '@glacier/icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLibrary } from './library.tsx';
import { useServerSession } from './serverSession.tsx';
import { trackIdFromPath } from './server.ts';
import {
  fetchStatsSummary,
  fmtMinutes,
  fmtPercent,
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
 * The charts are plain divs on purpose. Two bar charts and three meters do
 * not earn a charting library, and divs inherit the app's tokens - accent,
 * surfaces, motion preferences - for free.
 *
 * Everything renders from a normalised summary (stats.ts), so a missing or
 * partial field is an empty section here, never a crash. Sections that would
 * say nothing - an empty top-ten, a sound profile the server has not built -
 * simply do not appear.
 */

const RANGES: { id: StatsRange; label: string }[] = [
  { id: 'week', label: 'This week' },
  { id: 'month', label: 'This month' },
  { id: 'year', label: 'This year' },
  { id: 'all', label: 'All time' },
];

/** The hours the clock's axis names. Four is enough to orient by. */
const AXIS_HOURS = new Set([0, 6, 12, 18]);

/** How many day bars show before the chart starts to crush. */
const MAX_DAY_BARS = 30;

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

/** One headline number with the icon that names it. */
function Tile({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="statsTile">
      <span className="statsTile__icon" aria-hidden>
        {icon}
      </span>
      <span className="statsTile__value">{value}</span>
      <span className="statsTile__label">{label}</span>
    </div>
  );
}

/** A labelled 0..1 fill - the sound profile wears three of these. */
function Meter({ label, value }: { label: string; value: number }) {
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

  useEffect(() => {
    if (!session) return;
    setState('loading');
    const ctrl = new AbortController();
    void fetchStatsSummary(session, range, ctrl.signal)
      .then((s) => {
        setSummary(s);
        setState('ready');
      })
      .catch(() => {
        // An older server without the endpoint, or no network. A switched
        // range aborts the old fetch, and an abort is not an error state.
        if (!ctrl.signal.aborted) setState('error');
      });
    return () => ctrl.abort();
  }, [session, range]);

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
        <div className="statsTiles" aria-hidden>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="statsTile" data-ghost />
          ))}
        </div>
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

  const days = summary.byDay.slice(-MAX_DAY_BARS);
  const dayMax = days.reduce((m, d) => Math.max(m, d.minutes), 0);
  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  const artists = summary.topArtists.slice(0, 10);
  const songs = summary.topTracks.slice(0, 10);
  const albums = summary.topAlbums.slice(0, 8);
  const genres = summary.topGenres.slice(0, 8);
  const genreMax = genres.reduce((m, g) => Math.max(m, g.minutes), 0);

  return (
    <div className="homePage statsPage">
      {chips}

      <section className="statsSection">
        <div className="statsTiles">
          <Tile icon={<Clock size={16} />} value={fmtMinutes(summary.minutes)} label="listened" />
          <Tile icon={<Play size={16} />} value={summary.plays.toLocaleString()} label="plays" />
          <Tile
            icon={<Music size={16} />}
            value={summary.uniqueTracks.toLocaleString()}
            label="different songs"
          />
          <Tile
            icon={<User size={16} />}
            value={summary.uniqueArtists.toLocaleString()}
            label="different artists"
          />
          <Tile
            icon={<Flame size={16} />}
            value={`${summary.streakDays} ${summary.streakDays === 1 ? 'day' : 'days'}`}
            label="streak"
          />
          <Tile
            icon={<SkipForward size={16} />}
            value={fmtPercent(summary.skipRate)}
            label="skip rate"
          />
        </div>
        {summary.firstListens > 0 && (
          <p className="statsFirsts">
            {summary.firstListens.toLocaleString()}{' '}
            {summary.firstListens === 1 ? 'song' : 'songs'} you&rsquo;d never played before
          </p>
        )}
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

      <section className="statsSection">
        <Heading icon={<CalendarDays size={14} />}>Day by day</Heading>
        {days.length === 0 || dayMax === 0 ? (
          <p className="statsQuiet">Nothing yet for this range.</p>
        ) : (
          <div className="statsDays" role="img" aria-label={`Minutes per day, last ${days.length} days`}>
            <div className="statsDays__row">
              {days.map((d) => (
                <span
                  key={d.day}
                  className="statsDays__col"
                  title={`${fmtDay(d.day)} — ${Math.round(d.minutes)} min`}
                >
                  {d.minutes > 0 && (
                    <span
                      className="statsDays__fill"
                      style={{ blockSize: `${(d.minutes / dayMax) * 100}%` }}
                    />
                  )}
                </span>
              ))}
            </div>
            {firstDay && lastDay && firstDay.day !== lastDay.day && (
              <div className="statsDays__edges" aria-hidden>
                <span>{fmtDay(firstDay.day)}</span>
                <span>{fmtDay(lastDay.day)}</span>
              </div>
            )}
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
                  <span className="statsRow__art" data-shape="circle">
                    {cover ? (
                      <img src={cover} alt="" loading="lazy" />
                    ) : (
                      <User size={16} aria-hidden />
                    )}
                  </span>
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
                  <span className="statsRow__art" data-shape="square">
                    {mine?.artwork ? (
                      <img src={mine.artwork} alt="" loading="lazy" />
                    ) : (
                      <Music size={16} aria-hidden />
                    )}
                  </span>
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

      {(albums.length > 0 || genres.length > 0) && (
        <div className="statsSplit">
          {albums.length > 0 && (
            <section className="statsSection">
              <Heading icon={<Disc3 size={14} />}>Top albums</Heading>
              <ol className="statsSmallRows">
                {albums.map((row, i) => (
                  <li key={`${row.album}:${row.artist}:${i}`} className="statsSmallRow">
                    <span className="statsSmallRow__body">
                      <span className="statsSmallRow__name">{row.album || 'Unknown album'}</span>
                      <span className="statsSmallRow__sub">{row.artist}</span>
                    </span>
                    <span className="statsSmallRow__meta">
                      {row.plays.toLocaleString()} {row.plays === 1 ? 'play' : 'plays'}
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {genres.length > 0 && (
            <section className="statsSection">
              <Heading icon={<Tag size={14} />}>Top genres</Heading>
              <ol className="statsSmallRows">
                {genres.map((row, i) => (
                  <li key={`${row.genre}:${i}`} className="statsSmallRow" data-meter>
                    <span className="statsSmallRow__body">
                      <span className="statsSmallRow__name">{row.genre || 'Unknown genre'}</span>
                      <span className="statsGenreRail" aria-hidden>
                        <span
                          className="statsGenreFill"
                          style={{
                            inlineSize:
                              genreMax > 0 ? `${(row.minutes / genreMax) * 100}%` : '0%',
                          }}
                        />
                      </span>
                    </span>
                    <span className="statsSmallRow__meta">{fmtMinutes(row.minutes)}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
        </div>
      )}

      {summary.sound && (
        <section className="statsSection">
          <Heading icon={<AudioWaveform size={14} />}>Your sound</Heading>
          <div className="statsSound">
            <div className="statsTempo">
              <span className="statsTempo__value">{Math.round(summary.sound.bpm)}</span>
              <span className="statsTempo__label">BPM</span>
            </div>
            <Meter label="Energy" value={summary.sound.energy} />
            <Meter label="Brightness" value={summary.sound.brightness} />
          </div>
        </section>
      )}
    </div>
  );
}
