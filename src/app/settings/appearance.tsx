import { accentOptions, accentSteps, type Theme } from '@glacier/tokens';
import type { DensityMode } from '@glacier/react';
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BRAND_ACCENTS } from './brandAccents.ts';
import { getThemePreset, isThemePreference, type ThemePreference } from './themePresets.ts';

export interface Appearance {
  theme: ThemePreference;
  accent: string;
  density: DensityMode;
  /**
   * Whether the Now Playing screen (and the rooms it opens) re-dress the
   * accent in the current album's own colour. On is the shipped behaviour;
   * off keeps the chosen accent everywhere, always.
   */
  dynamicAccent: boolean;
  /**
   * How large the whole interface draws, as a multiple of normal. Applied to
   * the root font size, which is the one knob that moves everything at once:
   * the app is built in rem throughout - the spacing scale, the radii, the type
   * ramp, every card's footprint - so one number here resizes the interface
   * uniformly rather than growing text out of the boxes that hold it.
   *
   * Deliberately NOT the same idea as `density`, which changes how tightly
   * things are packed at a fixed size. This changes the size.
   */
  scale: number;
}

/** What the setting offers, smallest first. Steps rather than a slider: a
 *  number that only ever lands on a known value is one that can be reasoned
 *  about, and every one of these has been looked at. */
export const UI_SCALES = [0.85, 0.925, 1, 1.1, 1.25] as const;

const MIN_SCALE = UI_SCALES[0]!;
const MAX_SCALE = UI_SCALES[UI_SCALES.length - 1]!;

/** A stored or chosen scale, made safe: a number in range, or normal. */
export function clampScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n)) return 1;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));
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
  // Dark, not the OS preference. A music library is artwork on a dark wall -
  // the whole surface is built around covers glowing out of near-black, and a
  // listener whose phone happens to be in light mode should not meet a
  // different app than everyone else. Light is still one tap away in Settings,
  // and a listener who has chosen it keeps it: this is only the value a fresh
  // install starts from.
  theme: 'dark',
  accent: DEFAULT_ACCENT,
  density: 'comfortable',
  dynamicAccent: true,
  scale: 1,
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
      dynamicAccent:
        typeof parsed.dynamicAccent === 'boolean' ? parsed.dynamicAccent : DEFAULT_APPEARANCE.dynamicAccent,
      // Clamped on the way in as well as the way out: a value edited by hand
      // in storage should not be able to render the app unusable.
      scale: clampScale(parsed.scale),
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

    // As a percentage of the browser's own base size rather than a hard pixel
    // count, so a listener who has raised their default text size keeps that
    // and this scales on top of it. Cleared at normal, leaving the stylesheet
    // untouched.
    const scale = clampScale(appearance.scale);
    if (scale === 1) root.style.removeProperty('font-size');
    else root.style.setProperty('font-size', `${(scale * 100).toFixed(3)}%`);

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
    } catch {
      // Storage refused (private mode, quota): the choice still applies for
      // this run. This provider wraps the whole tree, so a throw here would
      // blank the app over a preference that was already on screen.
    }
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
