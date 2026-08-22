import { useMemo } from 'react';
import { useCardStyle } from '../settings/cardStyle.ts';

/**
 * The two bones a plain library door does not have, that two of the shipped
 * card styles are built on.
 *
 * Real covers wants a grid of the collection's own sleeves; Numbers first
 * wants the count alone and large. Both live in the card's markup at all times
 * so switching style stays a change of stylesheet and nothing re-renders - with
 * one exception below - the same contract the other four styles keep by leaning
 * only on the picture, the name and the count that were always there.
 *
 * The exception is the mosaic's images. Left rendered on every door they would
 * have four collections each fetch nine covers for a face nobody has chosen, so
 * the cells only mount under `mosaic` (or when a picker preview forces the look
 * on regardless of the live choice). That costs a re-render when the setting
 * changes, which is a thing that happens by hand once.
 */
export function LibChipMosaic({ covers, force }: { covers: string[]; force?: boolean }) {
  const style = useCardStyle();
  const on = force || style === 'mosaic';
  // Distinct sleeves only, up to nine: an album playlist is not the same cover
  // nine times, and the grid is 3x3.
  const cells = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const c of covers) {
      if (!c || seen.has(c)) continue;
      seen.add(c);
      out.push(c);
      if (out.length >= 9) break;
    }
    return out;
  }, [covers]);
  return (
    <span className="libChip__mosaic" aria-hidden="true">
      {on
        ? Array.from({ length: 9 }, (_, i) =>
            cells[i] ? (
              <img key={i} src={cells[i]} alt="" loading="lazy" />
            ) : (
              <span key={i} className="libChip__hole" />
            ),
          )
        : null}
    </span>
  );
}

/** The count on its own, for Numbers first. Absent where a door has no number
 *  to lead with (On repeat, DJ) - the style then falls back to the name, which
 *  is the honest thing to lead with when there is no figure.
 *
 *  `glyph` marks a value that is a SYMBOL rather than a figure - the DJ's
 *  infinity. A digit fills its line box from baseline to cap height, and the
 *  card's spacing was tuned around that; a symbol does not, so at the same
 *  font-size it draws barely half the ink and floats in the middle of a box
 *  sized for numerals, leaving a hole under the label. The class is what the
 *  stylesheet needs to size it by its ink instead. */
export function LibChipStat({ value, glyph }: { value?: string; glyph?: boolean }) {
  if (!value) return null;
  return (
    <span className={glyph ? 'libChip__stat libChip__stat--glyph' : 'libChip__stat'} aria-hidden="true">
      {value}
    </span>
  );
}
