import { ArtistLink } from '../ux/ArtistLink.tsx';
import { Button } from '@glacier/react';
import { ChartNoAxesColumn, Flame, Music, User } from '@glacier/icons';
import { useEffect, useState, type ReactNode } from 'react';
import { useServerSession } from '../servers/serverSession.tsx';
import { fetchStatsSummary, fmtMinutes, type StatsSummary } from '../profile/stats.ts';
import { hueOf } from '../search/searchModel.tsx';
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
    <section className="statsGlance" aria-label="Your listening this week">
      <p className="statsGlance__time">
        <span className="statsGlance__value">{fmtMinutes(summary.minutes)}</span>
        <span className="statsGlance__label">listened this week</span>
      </p>

      <div className="statsMinis statsMinis--three">
        <Mini
          icon={<Flame size={15} />}
          value={String(summary.streakDays)}
          label={summary.streakDays === 1 ? 'day streak' : 'day streak'}
        />
        <Mini
          icon={<Music size={15} />}
          value={summary.uniqueTracks.toLocaleString()}
          label={summary.uniqueTracks === 1 ? 'song' : 'songs'}
        />
        {/* The name is the interesting number here, but a week with plays and
            no clear leader still has a count to show, so the card never goes
            missing and leaves a two-across row behind. */}
        <Mini
          icon={<User size={15} />}
          value={topArtist ? <ArtistLink artist={topArtist} /> : summary.uniqueArtists.toLocaleString()}
          label={topArtist ? 'top artist' : summary.uniqueArtists === 1 ? 'artist' : 'artists'}
        />
      </div>

      <Button variant="soft" size="sm" className="statsGlance__all" onClick={onOpenStats}>
        <ChartNoAxesColumn size={15} />
        View all stats
      </Button>
    </section>
  );
}

function Mini({ icon, value, label }: { icon: ReactNode; value: ReactNode; label: string }) {
  return (
    <div className="statsMini" style={hueOf(label)}>
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
