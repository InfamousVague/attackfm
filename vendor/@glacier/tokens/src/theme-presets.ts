import {
  WHITE,
  accentOptions,
  accentSteps,
  rampSteps,
  ramps,
  type RampDef,
  type Theme,
} from './color.ts';

type Decl = [name: string, value: string];

export const themePresetIds = ['light', 'dark', 'dawn', 'boreal', 'ember'] as const;

export type ThemePresetId = (typeof themePresetIds)[number];
export type ThemePresetAccent = 'blue' | 'red' | 'green' | 'amber';

export interface ThemePreviewPalette {
  background: string;
  sidebar: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
}

interface CustomThemeTokens {
  neutral: RampDef;
  semantic: Record<string, string>;
  glass: Record<string, string>;
}

export interface ThemePresetDefinition {
  id: ThemePresetId;
  scheme: Theme;
  accent: ThemePresetAccent;
  preview: ThemePreviewPalette;
}

const defaultNeutral = ramps.find((ramp) => ramp.name === 'gray')!;

const customThemes: Partial<Record<ThemePresetId, CustomThemeTokens>> = {
  dawn: {
    neutral: { name: 'gray', hue: 46, chroma: 0.03, contrast: 'white' },
    semantic: {
      'surface-raised': 'oklch(0.998 0.004 55)',
      overlay: 'oklch(0.22 0.025 40 / 0.42)',
      'text-subtle': 'oklch(0.49 0.028 42)',
      'segment-track': 'oklch(0.92 0.02 50 / 0.72)',
      'segment-thumb': 'oklch(0.998 0.004 55)',
      'slider-thumb': 'oklch(0.998 0.004 55)',
    },
    glass: {
      'glass-thin': 'oklch(0.985 0.012 52 / 0.48)',
      'glass-regular': 'oklch(0.985 0.012 52 / 0.68)',
      'glass-thick': 'oklch(0.985 0.012 52 / 0.86)',
      'glass-border': 'oklch(0.4 0.03 42 / 0.12)',
      'glass-highlight': 'oklch(1 0 0 / 0.82)',
    },
  },
  boreal: {
    neutral: { name: 'gray', hue: 165, chroma: 0.028, contrast: 'white' },
    semantic: {
      'surface-sunken': 'oklch(0.105 0.015 165)',
      overlay: 'oklch(0.055 0.015 165 / 0.7)',
      'segment-track': 'oklch(0.27 0.025 165 / 0.62)',
      'segment-thumb': 'oklch(0.56 0.026 165)',
      'slider-thumb': 'oklch(0.91 0.014 165)',
    },
    glass: {
      'glass-thin': 'oklch(0.22 0.024 165 / 0.44)',
      'glass-regular': 'oklch(0.22 0.024 165 / 0.64)',
      'glass-thick': 'oklch(0.19 0.022 165 / 0.88)',
      'glass-border': 'oklch(0.9 0.025 165 / 0.11)',
      'glass-highlight': 'oklch(0.96 0.02 165 / 0.11)',
    },
  },
  ember: {
    neutral: { name: 'gray', hue: 48, chroma: 0.03, contrast: 'white' },
    semantic: {
      'surface-sunken': 'oklch(0.11 0.016 48)',
      overlay: 'oklch(0.06 0.016 48 / 0.72)',
      'segment-track': 'oklch(0.28 0.027 48 / 0.62)',
      'segment-thumb': 'oklch(0.58 0.028 48)',
      'slider-thumb': 'oklch(0.92 0.014 48)',
    },
    glass: {
      'glass-thin': 'oklch(0.23 0.027 48 / 0.44)',
      'glass-regular': 'oklch(0.23 0.027 48 / 0.64)',
      'glass-thick': 'oklch(0.2 0.025 48 / 0.88)',
      'glass-border': 'oklch(0.94 0.025 48 / 0.11)',
      'glass-highlight': 'oklch(0.98 0.018 48 / 0.11)',
    },
  },
};

function previewPalette(scheme: Theme, accentName: ThemePresetAccent, neutral = defaultNeutral): ThemePreviewPalette {
  const gray = rampSteps(neutral, scheme);
  const accentOption = accentOptions.find((option) => option.name === accentName) ?? accentOptions[0]!;
  const accent = accentSteps(accentOption, scheme);
  return {
    background: gray[0]!,
    sidebar: gray[1]!,
    surface: scheme === 'light' ? WHITE : gray[2]!,
    border: gray[5]!,
    text: gray[11]!,
    muted: gray[10]!,
    accent: accent[8]!,
    accentSoft: accent[2]!,
  };
}

const preset = (
  id: ThemePresetId,
  scheme: Theme,
  accent: ThemePresetAccent,
): ThemePresetDefinition => ({
  id,
  scheme,
  accent,
  preview: previewPalette(scheme, accent, customThemes[id]?.neutral),
});

export const themePresets: readonly ThemePresetDefinition[] = [
  preset('light', 'light', 'blue'),
  preset('dark', 'dark', 'blue'),
  preset('dawn', 'light', 'red'),
  preset('boreal', 'dark', 'green'),
  preset('ember', 'dark', 'amber'),
];

export function systemThemePreview(scheme: Theme): ThemePreviewPalette {
  return previewPalette(scheme, 'blue');
}

export function themePresetDecls(id: ThemePresetId): Decl[] {
  const custom = customThemes[id];
  if (!custom) return [];
  const scheme = themePresets.find((item) => item.id === id)?.scheme ?? 'light';
  const gray = rampSteps(custom.neutral, scheme);
  return [
    ...gray.map((value, index) => [`gray-${index + 1}`, value] as Decl),
    ...Object.entries(custom.glass),
    ...Object.entries(custom.semantic),
  ];
}