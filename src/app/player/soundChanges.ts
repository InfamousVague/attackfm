import { useMemo } from 'react';
import { useEqualizer } from './equalizer.tsx';
import { useFxChain } from './fxChain.ts';
import { useStemsOut } from './StemsRoom.tsx';

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

/** What the button says out loud, for anyone not looking at the badge. */
export function soundChangesLabel(c: SoundChanges): string {
  if (c.total === 0) return 'Sound';
  const parts: string[] = [];
  if (c.effects > 0) parts.push(c.effects === 1 ? '1 effect' : `${c.effects} effects`);
  if (c.stems > 0) parts.push(c.stems === 1 ? '1 part out' : `${c.stems} parts out`);
  if (c.eq) parts.push('EQ set');
  return `Sound — ${parts.join(', ')}`;
}
