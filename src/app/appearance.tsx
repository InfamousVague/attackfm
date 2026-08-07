import { accentOptions, accentSteps, type Theme } from '@glacier/tokens';
import type { DensityMode } from '@glacier/react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BRAND_ACCENTS } from './brandAccents.ts';
import { getThemePreset, isThemePreference, type ThemePreference } from './themePresets.ts';

export interface Appearance {
  theme: ThemePreference;
  accent: string;
  density: DensityMode;
}

// The blue that ships as the kit's own default, applied by removing data-accent.
const KIT_DEFAULT_ACCENT = accentOptions[0]!.name;

// Scale the lightness of the saturated steps (8-12) down, hardest at the solids
// (9-10), leaving the tint backgrounds (1-7) alone. Input/output are the kit's
// `oklch(L C H)` strings.
function deepenRamp(steps: string[], amount: number): string[] {
  const weight: Record<number, number> = { 8: 0.6, 9: 1, 10: 1, 11: 0.7, 12: 0.35 };
  return steps.map((step, index) => {
    const w = weight[index + 1];
    if (!w || amount <= 0) return step;
    const match = /oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/.exec(step);
    if (!match) return step;
    const l = Math.max(0.2, Number(match[1]) * (1 - amount * w));
    return `oklch(${l.toFixed(3)} ${match[2]} ${match[3]})`;
  });
}

// The brand orange is the default; blue and the rest stay available in settings.
const DEFAULT_ACCENT = 'attack';

const DEFAULT_APPEARANCE: Appearance = {
  theme: 'system',
  accent: DEFAULT_ACCENT,
  density: 'comfortable',
};

// Bumped to -v2 so a value saved before the brand accent existed (which pinned
// the old blue default) is dropped rather than pinning it forever.
const STORAGE_KEY = 'attackfm-appearance-v2';

interface AppearanceContextValue extends Appearance {
  update: (next: Partial<Appearance>) => void;
}

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function readStored(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      theme: isThemePreference(parsed.theme) ? parsed.theme : DEFAULT_APPEARANCE.theme,
      accent: typeof parsed.accent === 'string' ? parsed.accent : DEFAULT_APPEARANCE.accent,
      density: (parsed.density as DensityMode) ?? DEFAULT_APPEARANCE.density,
    };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function prefersDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

/**
 * Holds the appearance choices and writes them to the document root, where the
 * Glacier token layer reads them: `data-theme`/`data-theme-preset` for the
 * palette, `data-accent` for a built-in accent ramp, and `data-density` for the
 * spacing scale. Attributes are removed at their defaults so the base tokens
 * (and the OS colour scheme, for system) show through. A brand accent has no
 * `[data-accent]` rule, so its twelve steps are written inline instead, rebuilt
 * for whichever scheme is showing. Choices persist to localStorage.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(readStored);
  const [systemDark, setSystemDark] = useState(prefersDark);

  // A brand accent's ramp is scheme-specific, so track the OS scheme for when
  // the theme is set to system.
  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!mq) return;
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const preset = getThemePreset(appearance.theme);

    if (preset.mode === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preset.mode);
    root.setAttribute('data-theme-preset', preset.id);

    // Clear any brand ramp from a previous choice before applying this one.
    for (let step = 1; step <= 12; step += 1) root.style.removeProperty(`--glacier-accent-${step}`);
    root.style.removeProperty('--glacier-accent-contrast');

    const brand = BRAND_ACCENTS[appearance.accent];
    if (brand) {
      root.removeAttribute('data-accent');
      const scheme: Theme = preset.mode === 'system' ? (systemDark ? 'dark' : 'light') : preset.mode;
      deepenRamp(accentSteps(brand, scheme), brand.deep ?? 0).forEach((value, index) =>
        root.style.setProperty(`--glacier-accent-${index + 1}`, value),
      );
      root.style.setProperty(
        '--glacier-accent-contrast',
        brand.contrast === 'white' ? 'oklch(0.995 0 0)' : 'oklch(0.18 0 0)',
      );
    } else if (appearance.accent === KIT_DEFAULT_ACCENT) {
      root.removeAttribute('data-accent');
    } else {
      root.setAttribute('data-accent', appearance.accent);
    }

    if (appearance.density === 'comfortable') root.removeAttribute('data-density');
    else root.setAttribute('data-density', appearance.density);

    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  }, [appearance, systemDark]);

  const value = useMemo<AppearanceContextValue>(
    () => ({ ...appearance, update: (next) => setAppearance((current) => ({ ...current, ...next })) }),
    [appearance],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceContextValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error('useAppearance must be used within an AppearanceProvider');
  return value;
}
