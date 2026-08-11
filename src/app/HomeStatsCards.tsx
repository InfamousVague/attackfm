import { Clock, Flame, User } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useServerSession } from './serverSession.tsx';
import { fetchStatsSummary, fmtMinutes, type StatsSummary } from './stats.ts';
import './StatsPage.css';

/**
 * The week's numbers on the Home page: minutes, streak, top artist. Three
 * small doors into the stats page, not a summary of it - each card is the
 * same tap.
 *
 * Entirely self-sufficient so Home can drop it in one line: it fetches its
 * own week summary and renders nothing at all - not a skeleton, not an
 * apology - when signed out, when the server cannot answer (an older build
 * without the endpoint), or when the week has no minutes in it. A strip of
 * zeros on the front door would be the app talking about itself instead of
 * the music.
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
    <div className="statsMinis">
      <button type="button" className="statsMini" onClick={onOpenStats}>
        <span className="statsMini__icon" aria-hidden>
          <Clock size={16} />
        </span>
        <span className="statsMini__body">
          <span className="statsMini__value">{fmtMinutes(summary.minutes)}</span>
          <span className="statsMini__label">this week</span>
        </span>
      </button>
      <button type="button" className="statsMini" onClick={onOpenStats}>
        <span className="statsMini__icon" aria-hidden>
          <Flame size={16} />
        </span>
        <span className="statsMini__body">
          <span className="statsMini__value">
            {summary.streakDays} {summary.streakDays === 1 ? 'day' : 'days'}
          </span>
          <span className="statsMini__label">streak</span>
        </span>
      </button>
      {topArtist && (
        <button type="button" className="statsMini" onClick={onOpenStats}>
          <span className="statsMini__icon" aria-hidden>
            <User size={16} />
          </span>
          <span className="statsMini__body">
            <span className="statsMini__value">{topArtist}</span>
            <span className="statsMini__label">top artist</span>
          </span>
        </button>
      )}
    </div>
  );
}
