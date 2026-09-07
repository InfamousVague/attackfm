import { CircleCheck, Clock, Flame, Moon, Play, Radio, Repeat, Sparkles } from '@glacier/icons';
import { Skeleton } from '@glacier/react';
import { useMemo, type ReactNode } from 'react';
import type { StatsSummary } from './stats.ts';
import { useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';
import { fmtAxisMinutes, fmtHour } from './statsFormat.ts';

/** What `t` is, for the plain functions below that are handed one. */
type T = ReturnType<typeof useT>;

/**
 * The shape of a listening week, drawn.
 *
 * Four figures, each doing a different job, because "more stats" is not one
 * chart made bigger:
 *
 *  - the numbers people quote at each other -> stat tiles, not a bar chart of
 *    five unrelated quantities;
 *  - the SHAPE of a habit across incomparable measures -> the radar, which is
 *    the one form that answers "what kind of listener am I" at a glance;
 *  - one quantity across the 24 hours -> a heat strip, where colour carries
 *    magnitude and position carries time;
 *  - a ranked handful -> plain bars.
 *
 * Colour does one job here and one only: MAGNITUDE. Everything is a single
 * hue taken from the app's own accent ramp at varying strength, so there is no
 * categorical palette to mistake one series for another in, and the whole
 * thing re-themes with the app instead of pinning a hex. Text never wears the
 * series colour - the ink tokens carry every label, and the mark beside it
 * carries the value.
 */

// --- the numbers ------------------------------------------------------------

function StatTile({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="statTile">
      <span className="statTile__icon" aria-hidden>
        {icon}
      </span>
      {/* Proportional figures on purpose: tabular numerals make a standalone
          value look gappy, and nothing here lines up in a column. */}
      <span className="statTile__value">{value}</span>
      <span className="statTile__label">{label}</span>
    </div>
  );
}

/**
 * A span of minutes at tile size: whole hours once it is worth an hour.
 *
 * The "h" and the "m" were hard-coded letters, which is an English twelve-hour
 * reading of a unit; Intl knows the narrow unit in every locale, and knows the
 * locales that write it before the number.
 */
function hoursLabel(minutes: number): string {
  const big = minutes >= 60;
  const value = big ? (minutes / 60 >= 10 ? Math.round(minutes / 60) : Math.round(minutes / 6) / 10) : minutes;
  return formatNumber(value, {
    style: 'unit',
    unit: big ? 'hour' : 'minute',
    unitDisplay: 'narrow',
    maximumFractionDigits: 1,
  });
}

/**
 * The tiles' stand-in.
 *
 * Six of them, in the same grid, each with the icon disc and the two text
 * lines the real tile has - because the whole point of a placeholder is that
 * the layout it reserves is the layout that arrives. The labels are REAL: they
 * are static strings the page knows before any request, and text that never
 * changes is one more thing pinned in place across the swap.
 */
export function StatTilesSkeleton() {
  const t = useT();
  // The same six labels the real tiles carry. Four of them are counted words,
  // and there is no number yet to count with - so they stand in with the
  // form a count of zero picks, and are replaced the instant the tile is.
  const LABELS = [
    t('profile.statsListened'),
    t('profile.statsPlaysLabel', { count: 0 }),
    t('profile.artistsHeard', { count: 0 }),
    t('profile.statsStreak', { count: 0 }),
    t('profile.statsFinished'),
    t('profile.songsHeard', { count: 0 }),
  ];
  return (
    <div className="statTiles" aria-busy>
      {LABELS.map((label) => (
        <div key={label} className="statTile">
          <span className="statTile__icon" aria-hidden>
            <Skeleton variant="circle" width={15} height={15} />
          </span>
          <span className="statTile__value">
            <Skeleton variant="text" width="2.5rem" />
          </span>
          <span className="statTile__label">{label}</span>
        </div>
      ))}
    </div>
  );
}

export function StatTiles({ week }: { week: StatsSummary }) {
  const t = useT();
  return (
    <div className="statTiles">
      {/* Each label agrees with the number above it: "1 play" and "12 plays"
          are one key with two forms, not a word glued under a figure. */}
      <StatTile icon={<Clock size={15} />} value={hoursLabel(week.minutes)} label={t('profile.statsListened')} />
      <StatTile
        icon={<Play size={15} />}
        value={formatNumber(week.plays)}
        label={t('profile.statsPlaysLabel', { count: week.plays })}
      />
      <StatTile
        icon={<Radio size={15} />}
        value={formatNumber(week.uniqueArtists)}
        label={t('profile.artistsHeard', { count: week.uniqueArtists })}
      />
      <StatTile
        icon={<Flame size={15} />}
        value={
          week.streakDays
            ? formatNumber(week.streakDays, { style: 'unit', unit: 'day', unitDisplay: 'narrow' })
            : '—'
        }
        label={t('profile.statsStreak', { count: week.streakDays })}
      />
      <StatTile
        icon={<CircleCheck size={15} />}
        value={formatNumber(week.completionRate, { style: 'percent', maximumFractionDigits: 0 })}
        label={t('profile.statsFinished')}
      />
      <StatTile
        icon={<Sparkles size={15} />}
        value={formatNumber(week.uniqueTracks)}
        label={t('profile.songsHeard', { count: week.uniqueTracks })}
      />
    </div>
  );
}

// --- the radar --------------------------------------------------------------

export interface Axis {
  key: string;
  label: string;
  /** 0..1 */
  value: number;
  /** What the number actually means, for the readout under the chart. */
  detail: string;
}

/**
 * Six measures of a listening habit, each squashed to 0..1.
 *
 * A radar is the right form here for the reason it is the WRONG form almost
 * everywhere else: these axes are deliberately incomparable in their own units
 * (minutes, ratios, days) and nobody wants to read them against a shared
 * scale - the question is the silhouette. One series, fixed axis order, so
 * none of the usual radar failures (rank-coloured overlapping polygons, an
 * arbitrary axis order that changes the shape) can occur.
 *
 * Every ceiling is stated in the detail line rather than hidden, because a
 * normalised axis with a secret denominator is how these charts lie.
 */
export function profileAxes(week: StatsSummary, t: T): Axis[] {
  const clock = week.clock ?? [];
  const clockTotal = clock.reduce((a, b) => a + b, 0);
  const nightMinutes = clock.reduce((sum, v, hour) => (hour >= 21 || hour < 5 ? sum + v : sum), 0);
  const night = clockTotal > 0 ? nightMinutes / clockTotal : 0;

  // Artists per play, where "a new artist every third song" reads as full.
  const variety = week.plays > 0 ? Math.min(1, week.uniqueArtists / week.plays / 0.33) : 0;
  // Plays per distinct track above 1; twice through everything reads as full.
  const repeat = week.uniqueTracks > 0 ? Math.min(1, Math.max(0, week.plays / week.uniqueTracks - 1)) : 0;

  const pct = (v: number) => formatNumber(v, { style: 'percent', maximumFractionDigits: 0 });

  return [
    {
      key: 'volume',
      label: t('profile.radarVolume'),
      value: Math.min(1, week.minutes / 600),
      // The ceiling goes through the same formatter as the value, so the
      // sentence cannot read "10h" beside a locale that writes "10 Std.".
      detail: t('profile.radarDetailVolume', { amount: hoursLabel(week.minutes), ceiling: hoursLabel(600) }),
    },
    {
      key: 'variety',
      label: t('profile.radarVariety'),
      value: variety,
      // Two counted things in one line, and i18next selects a plural form for
      // one `count` at a time - so each half is its own counted key and this
      // sentence holds the two finished phrases.
      detail: t('profile.radarDetailVariety', {
        artists: t('profile.artistCount', { count: week.uniqueArtists }),
        plays: t('profile.statsPlayCount', { count: week.plays }),
      }),
    },
    {
      key: 'repeat',
      label: t('profile.radarRepeat'),
      value: repeat,
      detail:
        week.uniqueTracks > 0
          ? t('profile.radarDetailRepeat', {
              times: formatNumber(week.plays / week.uniqueTracks, {
                minimumFractionDigits: 1,
                maximumFractionDigits: 1,
              }),
            })
          : t('profile.radarDetailRepeatNone'),
    },
    {
      key: 'finish',
      label: t('profile.radarFinish'),
      value: week.completionRate,
      detail: t('profile.radarDetailFinish', { percent: pct(week.completionRate) }),
    },
    {
      key: 'night',
      label: t('profile.radarNight'),
      value: night,
      // The night boundary is 21:00 (see the reduce above); how that hour is
      // said - "9pm", "21", "21時" - is Intl's business, not the sentence's.
      detail: t('profile.radarDetailNight', { percent: pct(night), hour: fmtHour(21) }),
    },
    {
      key: 'streak',
      label: t('profile.radarStreak'),
      value: Math.min(1, week.streakDays / 7),
      detail: t('profile.radarDetailStreak', {
        days: formatNumber(week.streakDays),
        total: formatNumber(7),
      }),
    },
  ];
}

const RINGS = [0.25, 0.5, 0.75, 1];

/** The axis order, known before any data - so the empty web and its labels are
 *  drawn from the same list the real chart uses. Keys rather than words: this
 *  table is built at import, before any language has been chosen, and a
 *  string resolved here would stay in whatever language the app booted in. */
const AXIS_LABEL_KEYS = [
  'profile.radarVolume',
  'profile.radarVariety',
  'profile.radarRepeat',
  'profile.radarFinish',
  'profile.radarNight',
  'profile.radarStreak',
];

/**
 * The radar's stand-in: its own web, drawn empty.
 *
 * No pulsing bar could stand in for a hexagon without the page jumping when
 * the real one lands, so the placeholder IS the chart - same viewBox, same
 * rings, same labels - with the data polygon simply absent. The web dims
 * rather than shimmers, which reads as "not yet" without turning six static
 * lines into motion.
 */
export function ListeningRadarSkeleton() {
  const t = useT();
  const labels = AXIS_LABEL_KEYS.map((key) => t(key));
  const axes = labels.map((label, i) => ({ key: String(i), label, value: 0, detail: '' }));
  return (
    <figure className="radarFig" aria-busy>
      <svg viewBox="0 0 200 184" className="radar radar--pending" role="img" aria-label={t('profile.radarLoading')}>
        {RINGS.map((ring) => (
          <polygon key={ring} className="radar__ring" points={radarPoints(axes.length, ring)} />
        ))}
        {axes.map((a, i) => {
          const [x, y] = radarAt(axes.length, i, 1);
          return <line key={a.key} className="radar__spoke" x1={100} y1={92} x2={x} y2={y} />;
        })}
        {axes.map((a, i) => {
          const [x, y] = radarAt(axes.length, i, 1);
          const lx = 100 + (x - 100) * 1.17;
          const ly = 92 + (y - 92) * 1.17;
          const anchor = Math.abs(lx - 100) < 6 ? 'middle' : lx > 100 ? 'start' : 'end';
          return (
            <text
              key={a.key}
              className="radar__label"
              x={lx}
              y={ly + (Math.abs(lx - 100) < 6 ? (ly < 92 ? -2 : 8) : 3)}
              textAnchor={anchor}
            >
              {a.label}
            </text>
          );
        })}
      </svg>
      <figcaption className="radarKey">
        {labels.map((label) => (
          <span key={label} className="radarKey__row">
            <span className="radarKey__label">{label}</span>
            <span className="radarKey__detail">
              <Skeleton variant="text" width="6rem" />
            </span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

/** The one place the radar's geometry is written, shared by the chart and its
 *  placeholder so the two can never drift apart. */
function radarAt(count: number, i: number, t: number): readonly [number, number] {
  const angle = (-90 + (360 / count) * i) * (Math.PI / 180);
  return [100 + Math.cos(angle) * 62 * t, 92 + Math.sin(angle) * 62 * t] as const;
}

function radarPoints(count: number, t: number): string {
  return Array.from({ length: count }, (_, i) =>
    radarAt(count, i, t)
      .map((n) => n.toFixed(1))
      .join(','),
  ).join(' ');
}

export function ListeningRadar({ axes }: { axes: Axis[] }) {
  const t = useT();
  // Straight up for the first axis, clockwise from there - from the shared
  // helper, so the chart and its placeholder cannot drift apart.
  const { cx, cy, at } = useMemo(
    () => ({ cx: 100, cy: 92, at: (i: number, t: number) => radarAt(axes.length, i, t) }),
    [axes.length],
  );
  const points = axes.map((a, i) => at(i, Math.max(0.02, Math.min(1, a.value))));
  const path = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  // The screen-reader line: every axis and its share, as one sentence rather
  // than a label and a number stuck together.
  const readout = axes
    .map((a) =>
      t('profile.radarReadoutAxis', {
        label: a.label,
        percent: formatNumber(a.value, { style: 'percent', maximumFractionDigits: 0 }),
      }),
    )
    .join(', ');

  return (
    <figure className="radarFig">
      <svg
        viewBox="0 0 200 184"
        className="radar"
        role="img"
        aria-label={t('profile.radarLabel', { readout })}
      >
        {/* Recessive hairline web: solid, one shade off the surface. Never
            dashed - a dashed grid reads as a threshold. */}
        {RINGS.map((ring) => (
          <polygon key={ring} className="radar__ring" points={radarPoints(axes.length, ring)} />
        ))}
        {axes.map((a, i) => {
          const [x, y] = at(i, 1);
          return <line key={a.key} className="radar__spoke" x1={cx} y1={cy} x2={x} y2={y} />;
        })}

        <polygon className="radar__area" points={path} />
        <polygon className="radar__edge" points={path} />
        {points.map(([x, y], i) => (
          <circle key={axes[i]!.key} className="radar__node" cx={x} cy={y} r={4} />
        ))}

        {axes.map((a, i) => {
          const [x, y] = at(i, 1);
          // Labels ride just outside the web, pushed along their own angle so
          // they never sit on a spoke.
          const lx = cx + (x - cx) * 1.17;
          const ly = cy + (y - cy) * 1.17;
          const anchor = Math.abs(lx - cx) < 6 ? 'middle' : lx > cx ? 'start' : 'end';
          return (
            <text
              key={a.key}
              className="radar__label"
              x={lx}
              y={ly + (Math.abs(lx - cx) < 6 ? (ly < cy ? -2 : 8) : 3)}
              textAnchor={anchor}
            >
              {a.label}
            </text>
          );
        })}
      </svg>
      {/* The table view the chart owes its reader: every axis, its percentage
          and the real quantity behind it. */}
      <figcaption className="radarKey">
        {axes.map((a) => (
          <span key={a.key} className="radarKey__row">
            <span className="radarKey__label">{a.label}</span>
            <span className="radarKey__detail">{a.detail}</span>
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

// --- the day ----------------------------------------------------------------

/** Ticks worth naming. Labelling all 24 would be the "number on every point"
 *  mistake in axis form. */
const HOUR_TICKS = [0, 6, 12, 18];

/** Twenty-four cells at rest, same grid and height as the live strip. */
export function DayClockSkeleton() {
  const t = useT();
  return (
    <figure className="dayFig" aria-busy>
      <div className="dayStrip dayStrip--pending" role="img" aria-label={t('profile.clockLoading')}>
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="dayStrip__cell" />
        ))}
      </div>
      <figcaption className="dayAxis" aria-hidden>
        {HOUR_TICKS.map((h) => (
          <span key={h} className="dayAxis__tick" style={{ insetInlineStart: `${(h / 24) * 100}%` }}>
            {fmtHour(h)}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

export function DayClock({ clock }: { clock: number[] }) {
  const t = useT();
  const max = Math.max(1, ...clock);
  const peak = clock.indexOf(Math.max(...clock));

  return (
    <figure className="dayFig">
      <div
        className="dayStrip"
        role="img"
        aria-label={t('profile.statsClockLabel', { hour: fmtHour(peak) })}
      >
        {clock.map((minutes, hour) => (
          <span
            key={hour}
            className="dayStrip__cell"
            data-peak={hour === peak && minutes > 0 ? '' : undefined}
            // One hue, more-is-stronger. A floor keeps an empty hour a visible
            // cell rather than a hole in the strip.
            style={{ opacity: minutes > 0 ? 0.18 + (minutes / max) * 0.82 : 0.06 }}
            title={t('profile.statsClockTip', { hour: fmtHour(hour), minutes: fmtAxisMinutes(minutes) })}
          />
        ))}
      </div>
      <figcaption className="dayAxis" aria-hidden>
        {HOUR_TICKS.map((h) => (
          <span key={h} className="dayAxis__tick" style={{ insetInlineStart: `${(h / 24) * 100}%` }}>
            {fmtHour(h)}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

// --- the ranked handful -----------------------------------------------------

/** Five rows in the real three-column grid, so the list does not resize when
 *  the genres land. */
export function GenreBarsSkeleton() {
  return (
    <div className="genreBars" aria-busy>
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="genreBar">
          <span className="genreBar__name">
            <Skeleton variant="text" width="4.5rem" />
          </span>
          <span className="genreBar__track" />
          <span className="genreBar__value">
            <Skeleton variant="text" width="2rem" />
          </span>
        </div>
      ))}
    </div>
  );
}

export function GenreBars({ genres }: { genres: { genre: string; minutes: number }[] }) {
  const top = genres.slice(0, 5);
  const max = Math.max(1, ...top.map((g) => g.minutes));
  return (
    <div className="genreBars">
      {top.map((g) => (
        <div key={g.genre} className="genreBar">
          <span className="genreBar__name">{g.genre}</span>
          <span className="genreBar__track">
            <span className="genreBar__fill" style={{ inlineSize: `${(g.minutes / max) * 100}%` }} />
          </span>
          <span className="genreBar__value">{hoursLabel(g.minutes)}</span>
        </div>
      ))}
    </div>
  );
}

// --- the icon a habit earns -------------------------------------------------

/**
 * One badge naming the week, from the shape rather than from any single number
 * - the thing people actually want to be told about themselves. Picked by the
 * strongest axis so it changes as the habit does.
 */
export function HabitBadge({ axes }: { axes: Axis[] }) {
  const t = useT();
  const strongest = [...axes].sort((a, b) => b.value - a.value)[0];
  if (!strongest || strongest.value < 0.25) return null;
  const BADGE: Record<string, { icon: ReactNode; title: string }> = {
    volume: { icon: <Clock size={14} />, title: t('profile.badgeHeavyWeek') },
    variety: { icon: <Sparkles size={14} />, title: t('profile.badgeExplorer') },
    repeat: { icon: <Repeat size={14} />, title: t('profile.badgeOnRepeat') },
    finish: { icon: <CircleCheck size={14} />, title: t('profile.badgeFinisher') },
    night: { icon: <Moon size={14} />, title: t('profile.badgeNightOwl') },
    // The streak badge wears the axis's own detail ("4 of 7 days") when there
    // is one, since the number is the boast.
    streak: {
      icon: <Flame size={14} />,
      title: axes.find((a) => a.key === 'streak')?.detail ?? t('profile.badgeStreak'),
    },
  };
  const badge = BADGE[strongest.key];
  if (!badge) return null;
  return (
    <span className="habitBadge">
      <span className="habitBadge__icon" aria-hidden>
        {badge.icon}
      </span>
      {badge.title}
    </span>
  );
}
