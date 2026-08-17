import {
  systemThemePreview,
  themePresetIds,
  themePresets,
  type ThemePresetAccent,
  type ThemePresetId,
  type ThemePreviewPalette,
} from '@glacier/tokens';

// The chooser offers the named presets plus an adaptive option that follows the
// OS. Mirrors the GlacierUI docs' own list.
export const THEME_IDS = ['system', ...themePresetIds] as const;

export type ThemePreference = 'system' | ThemePresetId;

export interface ThemePreset {
  id: ThemePreference;
  mode: 'system' | 'light' | 'dark';
  accent: ThemePresetAccent;
  palette: ThemePreviewPalette;
  /** Painted over the right half of the preview, for the adaptive option. */
  alternatePalette?: ThemePreviewPalette;
}

export const THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: 'system',
    mode: 'system',
    accent: 'blue',
    palette: systemThemePreview('light'),
    alternatePalette: systemThemePreview('dark'),
  },
  ...themePresets.map((preset) => ({
    id: preset.id,
    mode: preset.scheme,
    accent: preset.accent,
    palette: preset.preview,
  })),
] as const;

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

export function getThemePreset(value: ThemePreference): ThemePreset {
  return THEME_PRESETS.find((preset) => preset.id === value) ?? THEME_PRESETS[0]!;
}
