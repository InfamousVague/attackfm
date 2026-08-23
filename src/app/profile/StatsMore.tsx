import { ArtistLink } from '../ux/ArtistLink.tsx';
import { AudioWaveform, Disc3, Flame, Play, Tag } from '@glacier/icons';
import { Heatmap, ProgressRing, SegmentedBar } from '@glacier/react';
import { clamp01, fmtMinutes, type StatsSummary } from './stats.ts';
import { fmtDay } from './statsFormat.ts';
import { GENRE_DOT, GENRE_TONES, Heading, RowArt, SoundMeter } from './StatsBits.tsx';

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
  const albums = summary.topAlbums.slice(0, 8);
  const genres = summary.topGenres.slice(0, 8);

  return (
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
                  <span className="statsRow__sub">
                    <ArtistLink artist={row.artist} />
                  </span>
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
  );
}
