import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AudioEqualizerBand, AudioEqualizerPreset } from '@glacier/react';

const STORAGE_KEY = 'attackfm-eq';
// Matches the kit AudioEqualizer's default bands and the meter's EQ filters.
const BAND_COUNT = 8;
const FLAT: number[] = Array(BAND_COUNT).fill(0);

/**
 * The kit's own eight bands and stock presets, restated so the phone's
 * five-band view can be derived from them. The graph always runs all eight -
 * the narrow view is a way of holding the sliders, not a different equalizer.
 */
export const EQ_BANDS: readonly AudioEqualizerBand[] = [
  { id: 'sub', label: '32Hz' },
  { id: 'bass', label: '64Hz' },
  { id: 'low-mid', label: '125Hz' },
  { id: 'mid', label: '250Hz' },
  { id: 'presence', label: '500Hz' },
  { id: 'high-mid', label: '1kHz' },
  { id: 'high', label: '2kHz' },
  { id: 'air', label: '4kHz' },
];

export const EQ_PRESETS: readonly AudioEqualizerPreset[] = [
  { id: 'flat', label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0] },
  { id: 'bass-boost', label: 'Bass boost', gains: [6, 5, 4, 2, 0, -2, -3, -4] },
  { id: 'vocal', label: 'Vocal', gains: [-2, -1, 1, 3, 4, 3, 1, -1] },
  { id: 'air', label: 'Air', gains: [-4, -2, -1, 0, 1, 3, 5, 6] },
];

/**
 * Portrait keeps the ends and thins the middle: eight sliders do not fit a
 * phone held upright, and the omitted bands (64, 250, 1k) are the ones a
 * neighbouring slider stands in for most gracefully. Landscape gets all
 * eight back.
 */
export const EQ_NARROW_INDICES: readonly number[] = [0, 2, 4, 6, 7];
export const EQ_BANDS_NARROW: readonly AudioEqualizerBand[] = EQ_NARROW_INDICES.map(
  (i) => EQ_BANDS[i]!,
);
export const EQ_PRESETS_NARROW: readonly AudioEqualizerPreset[] = EQ_PRESETS.map((p) => ({
  ...p,
  gains: EQ_NARROW_INDICES.map((i) => p.gains[i] ?? 0),
}));

/** The five shown gains, read out of the full eight. */
export function narrowEqGains(full: readonly number[]): number[] {
  return EQ_NARROW_INDICES.map((i) => full[i] ?? 0);
}

/**
 * Five shown gains back into eight real ones. A hand that lands exactly on a
 * preset's shape gets that preset's true curve, hidden bands included. For a
 * manual move, only the hidden bands beside sliders that actually moved are
 * re-interpolated between their shown neighbours - the rest keep whatever a
 * previous preset put there, so nudging the treble does not quietly redraw
 * the bass.
 */
export function expandNarrowGains(shown: readonly number[], previous: readonly number[]): number[] {
  const presetIdx = EQ_PRESETS_NARROW.findIndex((p) =>
    p.gains.every((g, j) => g === (shown[j] ?? 0)),
  );
  if (presetIdx >= 0) return [...EQ_PRESETS[presetIdx]!.gains];

  const full = Array.from({ length: BAND_COUNT }, (_, i) => previous[i] ?? 0);
  const moved = new Set<number>();
  EQ_NARROW_INDICES.forEach((bandIdx, j) => {
    const next = shown[j] ?? 0;
    if (full[bandIdx] !== next) moved.add(bandIdx);
    full[bandIdx] = next;
  });
  // Each hidden band sits between two shown ones: 1 between 0 and 2, 3
  // between 2 and 4, 5 between 4 and 6.
  for (const [hidden, lo, hi] of [
    [1, 0, 2],
    [3, 2, 4],
    [5, 4, 6],
  ] as const) {
    if (moved.has(lo) || moved.has(hi)) full[hidden] = (full[lo]! + full[hi]!) / 2;
  }
  return full;
}

interface EqualizerContextValue {
  /** Per-band gains in dB, low to high, aligned with the meter's EQ filters. */
  gains: number[];
  /** The selected preset id, or undefined once a band is moved by hand. */
  preset: string | undefined;
  setGains: (gains: number[]) => void;
  setPreset: (preset: string | undefined) => void;
}

const EqualizerContext = createContext<EqualizerContextValue | null>(null);

function readStored(): { gains: number[]; preset?: string } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { gains?: unknown; preset?: unknown };
      if (Array.isArray(parsed.gains) && parsed.gains.length === BAND_COUNT) {
        return {
          gains: parsed.gains.map((g) => (typeof g === 'number' ? g : 0)),
          preset: typeof parsed.preset === 'string' ? parsed.preset : undefined,
        };
      }
    }
  } catch {
    // Fall through to the flat default.
  }
  return { gains: [...FLAT], preset: 'flat' };
}

/**
 * Owns the equalizer settings - the per-band gains and the chosen preset - and
 * persists them. The Player reads the gains and pushes them onto the audio
 * graph's filters; the Settings panel edits them.
 */
export function EqualizerProvider({ children }: { children: ReactNode }) {
  const initial = readStored();
  const [gains, setGains] = useState<number[]>(initial.gains);
  const [preset, setPreset] = useState<string | undefined>(initial.preset);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ gains, preset }));
    } catch {
      // A storage that will not take the setting is not worth failing over.
    }
  }, [gains, preset]);

  const value = useMemo<EqualizerContextValue>(
    () => ({ gains, preset, setGains, setPreset }),
    [gains, preset],
  );

  return <EqualizerContext.Provider value={value}>{children}</EqualizerContext.Provider>;
}

export function useEqualizer(): EqualizerContextValue {
  const value = useContext(EqualizerContext);
  if (!value) throw new Error('useEqualizer must be used within an EqualizerProvider');
  return value;
}
