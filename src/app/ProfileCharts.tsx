import { CircleCheck, Clock, Flame, Moon, Play, Radio, Repeat, Sparkles } from '@glacier/icons';
import { useMemo, type ReactNode } from 'react';
import type { StatsSummary } from './stats.ts';

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

function hoursLabel(minutes: number): string {
  if (minutes >= 60) {
    const h = minutes / 60;
    return h >= 10 ? `${Math.round(h)}h` : `${Math.round(h * 10) / 10}h`;
  }
  return `${minutes}m`;
}

export function StatTiles({ week }: { week: StatsSummary }) {
  return (
    <div className="statTiles">
      <StatTile icon={<Clock size={15} />} value={hoursLabel(week.minutes)} label="listened" />
      <StatTile icon={<Play size={15} />} value={week.plays.toLocaleString()} label="plays" />
      <StatTile icon={<Radio size={15} />} value={week.uniqueArtists.toLocaleString()} label="artists" />
      <StatTile icon={<Flame size={15} />} value={week.streakDays ? `${week.streakDays}d` : '—'} label="streak" />
      <StatTile
        icon={<CircleCheck size={15} />}
        value={`${Math.round(week.completionRate * 100)}%`}
        label="finished"
      />
      <StatTile icon={<Sparkles size={15} />} value={week.uniqueTracks.toLocaleString()} label="songs" />
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
export function profileAxes(week: StatsSummary): Axis[] {
  const clock = week.clock ?? [];
  const clockTotal = clock.reduce((a, b) => a + b, 0);
  const nightMinutes = clock.reduce((sum, v, hour) => (hour >= 21 || hour < 5 ? sum + v : sum), 0);
  const night = clockTotal > 0 ? nightMinutes / clockTotal : 0;

  // Artists per play, where "a new artist every third song" reads as full.
  const variety = week.plays > 0 ? Math.min(1, week.uniqueArtists / week.plays / 0.33) : 0;
  // Plays per distinct track above 1; twice through everything reads as full.
  const repeat = week.uniqueTracks > 0 ? Math.min(1, Math.max(0, week.plays / week.uniqueTracks - 1)) : 0;

  return [
    {
      key: 'volume',
      label: 'Volume',
      value: Math.min(1, week.minutes / 600),
      detail: `${hoursLabel(week.minutes)} of a 10h week`,
    },
    {
      key: 'variety',
      label: 'Variety',
      value: variety,
      detail: `${week.uniqueArtists} artists across ${week.plays} plays`,
    },
    {
      key: 'repeat',
      label: 'Repeat',
      value: repeat,
      detail:
        week.uniqueTracks > 0
          ? `${(week.plays / week.uniqueTracks).toFixed(1)}× per song`
          : 'nothing played twice',
    },
    {
      key: 'finish',
      label: 'Finish',
      value: week.completionRate,
      detail: `${Math.round(week.completionRate * 100)}% played through`,
    },
    { key: 'night', label: 'Night', value: night, detail: `${Math.round(night * 100)}% after 9pm` },
    {
      key: 'streak',
      label: 'Streak',
      value: Math.min(1, week.streakDays / 7),
      detail: `${week.streakDays} of 7 days`,
    },
  ];
}

const RINGS = [0.25, 0.5, 0.75, 1];

export function ListeningRadar({ axes }: { axes: Axis[] }) {
  const geometry = useMemo(() => {
    const cx = 100;
    const cy = 92;
    const r = 62;
    const at = (i: number, t: number) => {
      // Straight up for the first axis, clockwise from there.
      const angle = (-90 + (360 / axes.length) * i) * (Math.PI / 180);
      return [cx + Math.cos(angle) * r * t, cy + Math.sin(angle) * r * t] as const;
    };
    return { cx, cy, r, at };
  }, [axes.length]);

  const { cx, cy, r, at } = geometry;
  const points = axes.map((a, i) => at(i, Math.max(0.02, Math.min(1, a.value))));
  const path = points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const readout = axes.map((a) => `${a.label} ${Math.round(a.value * 100)}%`).join(', ');

  return (
    <figure className="radarFig">
      <svg
        viewBox="0 0 200 184"
        className="radar"
        role="img"
        aria-label={`Your listening shape: ${readout}`}
      >
        {/* Recessive hairline web: solid, one shade off the surface. Never
            dashed - a dashed grid reads as a threshold. */}
        {RINGS.map((t) => (
          <polygon
            key={t}
            className="radar__ring"
            points={axes.map((_, i) => at(i, t).map((n) => n.toFixed(1)).join(',')).join(' ')}
          />
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

export function DayClock({ clock }: { clock: number[] }) {
  const max = Math.max(1, ...clock);
  const peak = clock.indexOf(Math.max(...clock));
  const hour12 = (h: number) => (h === 0 ? '12a' : h === 12 ? '12p' : h > 12 ? `${h - 12}p` : `${h}a`);

  return (
    <figure className="dayFig">
      <div
        className="dayStrip"
        role="img"
        aria-label={`When you listen, by hour. Busiest around ${hour12(peak)}.`}
      >
        {clock.map((minutes, hour) => (
          <span
            key={hour}
            className="dayStrip__cell"
            data-peak={hour === peak && minutes > 0 ? '' : undefined}
            // One hue, more-is-stronger. A floor keeps an empty hour a visible
            // cell rather than a hole in the strip.
            style={{ opacity: minutes > 0 ? 0.18 + (minutes / max) * 0.82 : 0.06 }}
            title={`${hour12(hour)} · ${Math.round(minutes)} min`}
          />
        ))}
      </div>
      <figcaption className="dayAxis" aria-hidden>
        {HOUR_TICKS.map((h) => (
          <span key={h} className="dayAxis__tick" style={{ insetInlineStart: `${(h / 24) * 100}%` }}>
            {hour12(h)}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}

// --- the ranked handful -----------------------------------------------------

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
  const strongest = [...axes].sort((a, b) => b.value - a.value)[0];
  if (!strongest || strongest.value < 0.25) return null;
  const BADGE: Record<string, { icon: ReactNode; title: string }> = {
    volume: { icon: <Clock size={14} />, title: 'Heavy week' },
    variety: { icon: <Sparkles size={14} />, title: 'Explorer' },
    repeat: { icon: <Repeat size={14} />, title: 'On repeat' },
    finish: { icon: <CircleCheck size={14} />, title: 'Finisher' },
    night: { icon: <Moon size={14} />, title: 'Night owl' },
    streak: { icon: <Flame size={14} />, title: `${axes.find((a) => a.key === 'streak')?.detail ?? 'On a streak'}` },
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
