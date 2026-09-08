import type { StatsSummary } from './stats.ts';
import type { Translate } from '../settings/settingsShared.ts';
import { formatNumber } from '../ux/format.ts';
import { fmtHour, hoursLabel } from './statsFormat.ts';

/**
 * The radar's six numbers, worked out from a week.
 *
 * Split from `ProfileCharts.tsx` because this is arithmetic, not drawing: the
 * normalisations and their ceilings are the part of the chart that can be
 * WRONG - a denominator quietly changed, a night boundary moved, a ratio that
 * runs past 1 and pushes a vertex outside the web - and none of that is
 * visible in a rendered polygon.
 */

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
export function profileAxes(week: StatsSummary, t: Translate): Axis[] {
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
