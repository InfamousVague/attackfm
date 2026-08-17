import { type ReactNode } from 'react';
import { artSized } from '../server.ts';
import { useArtLoad } from '../ux/artLoad.ts';
import { clamp01 } from './stats.ts';

/** The stats page's presentational atoms: headings, covers, chips, meters. */

/** A section heading in the search page's idiom: glyph, then the words. */
export function Heading({ icon, children }: { icon: ReactNode; children: ReactNode }) {
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
export function RowArt({
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
export function ArtChip({
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
export function SoundMeter({ label, value }: { label: string; value: number }) {
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
export const GENRE_TONES = ['accent', 'success', 'warning', 'danger', 'neutral'] as const;
export const GENRE_DOT: Record<(typeof GENRE_TONES)[number], string> = {
  accent: 'var(--glacier-accent-solid)',
  success: 'var(--glacier-success-solid)',
  warning: 'var(--glacier-warning-solid)',
  danger: 'var(--glacier-danger-solid)',
  neutral: 'var(--glacier-border)',
};
