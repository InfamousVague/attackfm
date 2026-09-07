import { useMemo } from 'react';
import { useEqualizer } from './equalizer.tsx';
import { useFxChain } from './fxChain.ts';
import { useStemsOut } from './StemsRoom.tsx';
import { translate } from '../i18n/LocaleShell.tsx';
import { formatLocale } from '../ux/format.ts';

/**
 * How much the sound has been moved away from the record, as one number.
 *
 * The console's tabs have always said this a room at a time - HiFi's count,
 * Stems' count, Filters' dot - but all four rooms live behind one button, and
 * with the console shut there was nothing to say the song you are hearing is
 * not the song as it was mastered. That matters most for the state you cannot
 * hear you are in: a vocal left out two songs ago, a filter still on from
 * yesterday.
 *
 * ONE number, not a breakdown. The badge sits on a 20px glyph; anything that
 * needs a legend belongs in the console it opens.
 */
export interface SoundChanges {
  /** Live nodes in the chain - pedals, filters and the HiFi rack alike. */
  effects: number;
  /** Parts currently dropped from the stream. */
  stems: number;
  /** Whether the graphic EQ is bent away from flat. */
  eq: boolean;
  /** What the badge shows. Zero means you are hearing the record. */
  total: number;
}

/** Below this a band is level as far as anyone can hear, and as far as the
 *  slider can be put back by hand. */
const FLAT_ENOUGH = 0.05;

export function useSoundChanges(): SoundChanges {
  const chain = useFxChain();
  const stems = useStemsOut();
  const { gains } = useEqualizer();

  return useMemo(() => {
    // Every live node, which is also every filter: a filter IS chain nodes, so
    // counting the chain and then adding one for "a filter is on" would count
    // the same processing twice. The Filters tab draws a dot rather than a
    // number for the same reason.
    const effects = chain.nodes.filter((n) => n.on).length;
    const eq = gains.some((g) => Math.abs(g) > FLAT_ENOUGH);
    return { effects, stems, eq, total: effects + stems + (eq ? 1 : 0) };
  }, [chain, stems, gains]);
}

/**
 * What the button says out loud, for anyone not looking at the badge.
 *
 * Takes a translator so the two callers in the player chrome can hand it
 * `useT()` and have the label follow the language picker; the `translate`
 * default keeps the one-argument signature those callers still use working.
 *
 * The clauses are whole catalogue entries, plural forms included, rather than
 * a count glued to a noun: "1 effect"/"2 effects" is English's two-form
 * grammar written as a ternary, and the languages the app ships in have
 * between one and six forms.
 *
 * PlayerStrip strips the leading "Sound - " back off this to nest the detail
 * inside a longer label, which is why the English entry keeps that exact
 * prefix. It is a caller in another file's hands right now; when it can be
 * touched it should call `soundChangesDetail` and drop the surgery, because a
 * language whose entry does not start that way gets the prefix twice.
 */
export function soundChangesLabel(c: SoundChanges, t: SoundTranslate = translate): string {
  if (c.total === 0) return t('player.soundChangesNone');
  return t('player.soundChangesLabel', { detail: soundChangesDetail(c, t) });
}

/** Just the clauses - "2 effects, EQ set" - for a label that supplies its own
 *  opening. */
export function soundChangesDetail(c: SoundChanges, t: SoundTranslate = translate): string {
  const parts: string[] = [];
  if (c.effects > 0) parts.push(t('player.soundEffectsOn', { count: c.effects }));
  if (c.stems > 0) parts.push(t('player.soundStemsOut', { count: c.stems }));
  if (c.eq) parts.push(t('player.soundEqSet'));
  return joinClauses(parts);
}

/** A translator - `useT()`'s, or `translate` outside a component. */
export type SoundTranslate = (key: string, options?: Record<string, unknown>) => string;

/**
 * "a, b and c" - through Intl rather than a comma join, because the separator
 * and the word before the last item are both language, and Arabic does not
 * spell either of them the way a hard-coded ", " does.
 */
function joinClauses(parts: string[]): string {
  try {
    return new Intl.ListFormat(formatLocale(), { style: 'short', type: 'unit' }).format(parts);
  } catch {
    // An engine without ListFormat still has to say something.
    return parts.join(', ');
  }
}
