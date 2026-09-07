import { ArtistLink } from '../ux/ArtistLink.tsx';
import { AudioWaveform, Disc3, Flame, Play, Tag } from '@glacier/icons';
import { Heatmap, ProgressRing, SegmentedBar } from '@glacier/react';
import { clamp01, fmtMinutes, type StatsSummary } from './stats.ts';
import { fmtDay } from './statsFormat.ts';
import { formatNumber } from '../ux/format.ts';
import { GENRE_DOT, GENRE_TONES, Heading, RowArt, SoundMeter } from './StatsBits.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

/** One slice of the genre bar, computed by the page so the bar and the
 *  legend cannot diverge from the chips above the fold. */
export type GenreSegment = {
  value: number;
  /** `GENRE_TONES[i]` indexes past the list's end for the "everything else"
   *  push, so the inferred tone carries `undefined` - kept as-is. */
  tone: (typeof GENRE_TONES)[number] | undefined;
  label: string;
};

/**
 * Behind the "More stats" fold: rates, genres, albums, the sound profile,
 * a year in squares. Everything renders from the page's summary; yearDays
 * is fetched lazily by the page on first unfold and handed down.
 */
export function StatsMore({
  summary,
  genreSegments,
  genreTotal,
  albumArt,
  yearDays,
}: {
  summary: StatsSummary;
  genreSegments: GenreSegment[];
  genreTotal: number;
  albumArt: Map<string, string>;
  yearDays: StatsSummary['byDay'] | null;
}) {
  const t = useT();
  const albums = summary.topAlbums.slice(0, 8);
  const genres = summary.topGenres.slice(0, 8);

  return (
    <>
      <section className="statsSection">
        <Heading icon={<Play size={14} />}>{t('profile.statsHowYouListen')}</Heading>
        <div className="statsRings">
          <div className="statsRing">
            <ProgressRing
              value={Math.round(clamp01(summary.completionRate) * 100)}
              max={100}
              size={76}
              thickness={8}
              tone="accent"
              showValue
              aria-label={t('profile.statsFinishedLabel')}
            />
            <span className="statsRing__label">{t('profile.statsFinished')}</span>
          </div>
          <div className="statsRing">
            <ProgressRing
              value={Math.round(clamp01(summary.skipRate) * 100)}
              max={100}
              size={76}
              thickness={8}
              tone="warning"
              showValue
              aria-label={t('profile.statsSkippedLabel')}
            />
            <span className="statsRing__label">{t('profile.statsSkipped')}</span>
          </div>
          <div className="statsRing" data-wide>
            {/* formatNumber, not toLocaleString: the latter groups by the
                BROWSER's locale, not the one the app is set to. */}
            <span className="statsRing__big">{formatNumber(summary.firstListens)}</span>
            <span className="statsRing__label">
              {t('profile.statsNewToYou', { count: summary.firstListens })}
            </span>
          </div>
        </div>
      </section>

      {genres.length > 0 && (
        <section className="statsSection">
          <Heading icon={<Tag size={14} />}>{t('profile.statsGenresHeading')}</Heading>
          <SegmentedBar data={genreSegments} size="md" rounded aria-label={t('profile.statsGenreBarLabel')} />
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
                  {/* The percent sign is a unit like any other - Arabic writes
                      its own (٪) and some locales space it off the number. */}
                  {genreTotal > 0
                    ? formatNumber(seg.value / genreTotal, {
                        style: 'percent',
                        maximumFractionDigits: 0,
                      })
                    : ''}{' '}
                  · {fmtMinutes(seg.value)}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {albums.length > 0 && (
        <section className="statsSection">
          <Heading icon={<Disc3 size={14} />}>{t('profile.statsTopAlbumsHeading')}</Heading>
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
                    {row.album || t('common.unknownAlbum')}
                  </span>
                  <span className="statsRow__sub">
                    <ArtistLink artist={row.artist} />
                  </span>
                </span>
                <span className="statsRow__meta">
                  {t('profile.statsPlayCount', { count: row.plays })}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {summary.sound && (
        <section className="statsSection">
          <Heading icon={<AudioWaveform size={14} />}>{t('profile.statsSoundHeading')}</Heading>
          <div className="statsSound">
            <div className="statsTempo">
              <span className="statsTempo__value">{formatNumber(Math.round(summary.sound.bpm))}</span>
              <span className="statsTempo__label">{t('profile.statsBpm')}</span>
            </div>
            <SoundMeter label={t('profile.statsEnergy')} value={summary.sound.energy} />
            <SoundMeter label={t('profile.statsBrightness')} value={summary.sound.brightness} />
          </div>
        </section>
      )}

      {yearDays && yearDays.some((d) => d.minutes > 0) && (
        <section className="statsSection">
          <Heading icon={<Flame size={14} />}>{t('profile.statsYearHeading')}</Heading>
          <div className="statsHeat">
            <Heatmap
              data={yearDays.map((d) => ({ date: fmtDay(d.day), value: d.minutes }))}
              rows={7}
              legend
              aria-label={t('profile.statsYearChartLabel')}
            />
          </div>
        </section>
      )}
    </>
  );
}
