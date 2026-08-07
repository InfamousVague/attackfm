import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'attackfm-eq';
// Matches the kit AudioEqualizer's default bands and the meter's EQ filters.
const BAND_COUNT = 8;
const FLAT: number[] = Array(BAND_COUNT).fill(0);

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
