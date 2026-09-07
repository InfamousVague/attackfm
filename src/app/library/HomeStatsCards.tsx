import { ArtistLink } from '../ux/ArtistLink.tsx';
import { Button } from '@glacier/react';
import { ChartNoAxesColumn, Flame, Music, User } from '@glacier/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchStatsSummary, type StatsSummary } from '../profile/stats.ts';
import { formatNumber } from '../ux/format.ts';
import { hueOf } from '../search/searchModel.tsx';
import { useT } from '../i18n/LocaleShell.tsx';
import '../profile/StatsPage.css';

/**
 * The week at a glance, on the library page: how long you listened, three
 * numbers beside it, and one door into the whole stats page.
 *
 * The time leads because it is the number people actually mean by "how much
 * have I been listening" - it used to be one of three equal cards, which said
 * it no louder than the streak. The three below it are the supporting cast,
 * and they are plain readouts now rather than three identical buttons: with a
 * real "View all stats" underneath, making every card its own door meant four
 * controls that all did the same thing, which a screen reader has to announce
 * four times.
 *
 * Entirely self-sufficient so a page can drop it in one line: it fetches its
 * own week summary and renders nothing at all - not a skeleton, not an apology
 * - when signed out, when the server cannot answer (an older build without the
 * endpoint), or when the week has no minutes in it. A strip of zeros would be
 * the app talking about itself instead of the music.
 */
export function HomeStatsCards({ onOpenStats }: { onOpenStats: () => void }) {
  const t = useT();
  const { session } = useServerSession();
  const [summary, setSummary] = useState<StatsSummary | null>(null);

  useEffect(() => {
    setSummary(null);
    if (!session) return;
    const ctrl = new AbortController();
    void fetchStatsSummary(session, 'week', ctrl.signal)
      .then((s) => {
        if (!ctrl.signal.aborted) setSummary(s);
      })
      .catch(() => {
        // The strip's whole failure mode is absence.
      });
    return () => ctrl.abort();
  }, [session]);

  if (!session || !summary || summary.minutes === 0) return null;

  const topArtist = summary.topArtists[0]?.artist;

  return (
    <section className="statsGlance" aria-label={t('profile.weekGlance')}>
      <p className="statsGlance__time">
        <span className="statsGlance__value">{listened(summary.minutes)}</span>
        <span className="statsGlance__label">{t('profile.listenedThisWeek')}</span>
      </p>

      <div className="statsMinis statsMinis--three">
        <Mini
          seed="streak"
          icon={<Flame size={15} />}
          value={formatNumber(summary.streakDays)}
          label={t('profile.dayStreak', { count: summary.streakDays })}
        />
        <Mini
          seed="songs"
          icon={<Music size={15} />}
          value={formatNumber(summary.uniqueTracks)}
          label={t('profile.songsHeard', { count: summary.uniqueTracks })}
        />
        {/* The name is the interesting number here, but a week with plays and
            no clear leader still has a count to show, so the card never goes
            missing and leaves a two-across row behind. */}
        <Mini
          seed="artists"
          icon={<User size={15} />}
          value={topArtist ? <ArtistLink artist={topArtist} /> : summary.uniqueArtists.toLocaleString()}
          label={
            topArtist
              ? t('profile.topArtist')
              : t('profile.artistsHeard', { count: summary.uniqueArtists })
          }
        />
      </div>

      <Button variant="soft" size="sm" className="statsGlance__all" onClick={onOpenStats}>
        <ChartNoAxesColumn size={15} />
        {t('profile.viewAllStats')}
      </Button>
    </section>
  );
}

/**
 * "42 min" / "3.5 hr".
 *
 * Not `fmtMinutes` from profile/stats.ts, which spells the unit itself and so
 * says "min" to a reader whose app is in Japanese. The number and its unit are
 * one thing to Intl, and Intl is the only party that knows the abbreviation,
 * which side of the digits it sits, and how the digits group - so the whole
 * readout comes from it rather than from a template string.
 */
function listened(minutes: number): string {
  const whole = Math.max(0, Math.round(minutes));
  if (whole <= 120) {
    return formatNumber(whole, { style: 'unit', unit: 'minute', unitDisplay: 'short' });
  }
  const hours = whole / 60;
  // Past a hundred hours the tenth is noise, and a four-digit readout with a
  // decimal point in it stops fitting the card.
  const decimals = hours >= 100 ? 0 : 1;
  return formatNumber(hours, {
    style: 'unit',
    unit: 'hour',
    unitDisplay: 'short',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/* `seed` rather than the label: hueOf derives a colour from the characters it
   is given, so tinting by the visible word would repaint all three cards when
   the language changed - and give a German reader a different set of colours
   than an English one for the same three facts. */
function Mini({
  seed,
  icon,
  value,
  label,
}: {
  seed: string;
  icon: ReactNode;
  value: ReactNode;
  label: string;
}) {
  return (
    <div className="statsMini" style={hueOf(seed)}>
      <span className="statsMini__icon" aria-hidden>
        {icon}
      </span>
      <span className="statsMini__body">
        <span className="statsMini__value">{value}</span>
        <span className="statsMini__label">{label}</span>
      </span>
    </div>
  );
}
