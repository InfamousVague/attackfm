import { Text } from '@glacier/react';
import type { CSSProperties } from 'react';
import { CARD_STYLES, setCardStyle, useCardStyle } from './cardStyle.ts';
import { LibChipMosaic, LibChipStat } from '../library/LibChipFace.tsx';
import { useSongCount, useT } from '../i18n/LocaleShell.tsx';
import { formatNumber } from '../ux/format.ts';
import allSongsChip from '../../assets/chip-all-songs.webp';

/**
 * Six real cards, one per style, to choose between.
 *
 * The previews are the LIBRARY CARD's own markup and its own stylesheet, not a
 * drawing of one - `.libChip` with its art, its name and its count, wearing
 * `data-card-style` locally instead of on the document. That is what makes the
 * choice honest: these six differ mostly in what happens to the object, so a
 * swatch of the ground would show Emboss and Neon as near enough the same dark
 * rectangle, and Editorial - which has no object at all - as a blank.
 *
 * One card each rather than all four. The set reads as a set on the shelf; in
 * a settings pane at a third the width, four cards per style is twenty-four
 * tiles to compare and the treatment stops being visible at all. All songs
 * carries it, because its object is a plain chrome one and every style has to
 * do something visible to it.
 */
export function CardStylePicker({ count, covers = [] }: { count?: number; covers?: string[] }) {
  const chosen = useCardStyle();
  const t = useT();
  const songCount = useSongCount();

  return (
    <div className="cardPicks" role="radiogroup" aria-label={t('settings.cardStyle')}>
      {CARD_STYLES.map((style) => (
        <button
          key={style.id}
          type="button"
          role="radio"
          aria-checked={chosen === style.id}
          className="cardPick"
          data-card-style={style.id}
          data-selected={chosen === style.id || undefined}
          title={t(style.noteKey)}
          onClick={() => setCardStyle(style.id)}
        >
          {/* aria-hidden: the button is already named by the label below it,
              and a screen reader has nothing to gain from "All songs" read out
              six times in a row. */}
          <span
            className="libChip libChip--all"
            style={{ '--libChipHue': 214, '--art': `url("${allSongsChip}")` } as CSSProperties}
            aria-hidden="true"
          >
            <img className="libChip__art" src={allSongsChip} alt="" loading="lazy" />
            {/* Only the mosaic preview forces its grid to mount, so the other
                five tiles do not each fetch nine hidden sleeves. The stat bone
                is cheap text and rides along on every preview. */}
            <LibChipMosaic covers={covers} force={style.id === 'mosaic'} />
            {/* Grouped by Intl rather than String(): the stat bone is the one
                place a five-figure library is set large enough to read as a
                figure, and 12,438 / 12.438 / 12 438 is a locale's own answer. */}
            <LibChipStat value={formatNumber(count ?? 0)} />
            <span className="libChip__name">{t('library.allSongs')}</span>
            <span className="libChip__count">{songCount(count ?? 0)}</span>
          </span>
          <span className="cardPick__name">{t(style.nameKey)}</span>
        </button>
      ))}
    </div>
  );
}

/** The picker with its heading and the chosen style's own description. */
export function CardStyleSection({ count, covers }: { count?: number; covers?: string[] }) {
  const chosen = useCardStyle();
  const t = useT();
  const noteKey = CARD_STYLES.find((s) => s.id === chosen)?.noteKey;

  return (
    <>
      <CardStylePicker count={count} covers={covers} />
      <Text tone="muted" size="sm">
        {noteKey ? t(noteKey) : null}
      </Text>
    </>
  );
}
