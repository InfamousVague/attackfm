import { DensitySelector, Label, SegmentedControl, Text } from '@glacier/react';
import { accentOptions, accentSteps } from '@glacier/tokens';
import { BRAND_ACCENTS } from './brandAccents.ts';
import { clampScale, UI_SCALES, useAppearance } from './appearance.tsx';
import { ThemeSelector } from './ThemeSelector.tsx';
import { getThemePreset, THEME_PRESETS } from './themePresets.ts';
import { THEME_COPY } from './settingsShared.ts';
import { CardStyleSection } from './CardStylePicker.tsx';
import { useLibrary } from '../library/library.tsx';

/**
 * The appearance controls: the theme, accent, and spacing pulled from the
 * GlacierUI docs, each wired to the document root through the appearance store.
 */
export function Appearance() {
  const { theme, accent, density, scale, update } = useAppearance();
  // Only for the preview's count line, so the sample card says something true.
  const { tracks } = useLibrary();

  // The neutral themes wear the brand accent, so their preview cards should too
  // rather than the kit's blue. Paint the brand pink over the accent swatches of
  // system/light/dark, per scheme.
  const brandRamp = { light: accentSteps(BRAND_ACCENTS.attack!, 'light'), dark: accentSteps(BRAND_ACCENTS.attack!, 'dark') };
  const brandPreview = (palette: (typeof THEME_PRESETS)[number]['palette'], scheme: 'light' | 'dark') => ({
    ...palette,
    accent: brandRamp[scheme][8]!,
    accentSoft: brandRamp[scheme][2]!,
  });
  const NEUTRAL = ['system', 'light', 'dark'];
  // The three the app actually offers: Automatic leading, then the two hands
  // it can be forced into. The tinted presets (dawn/boreal/ember) stay in
  // themePresets - they still work, and an accent still recolours everything -
  // they just are not choices here any more. A listener already sitting on one
  // keeps seeing its card until they switch away, so the group never shows
  // nothing selected.
  const OFFERED = ['system', 'light', 'dark'];
  const shown = THEME_PRESETS.filter((p) => OFFERED.includes(p.id) || p.id === theme);

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Label>Theme</Label>
        <ThemeSelector
          aria-label="Theme"
          value={theme}
          leadFirst
          options={shown.map((preset) => {
            const neutral = NEUTRAL.includes(preset.id);
            return {
              value: preset.id,
              palette: neutral ? brandPreview(preset.palette, preset.id === 'dark' ? 'dark' : 'light') : preset.palette,
              alternatePalette:
                preset.id === 'system' && preset.alternatePalette
                  ? brandPreview(preset.alternatePalette, 'dark')
                  : preset.alternatePalette,
              ...THEME_COPY[preset.id],
            };
          })}
          // Choosing a theme takes its accent - except the neutral themes
          // (system/light/dark), which wear the brand accent rather than the
          // kit's blue.
          onValueChange={(next) =>
            update({
              theme: next,
              accent: NEUTRAL.includes(next) ? 'attack' : getThemePreset(next).accent,
            })
          }
        />
      </div>
      <div className="prefsSection">
        <Label>Accent</Label>
        <div className="accentSwatches" role="radiogroup" aria-label="Accent colour">
          {/* Brand accents first, then the kit's own. */}
          {[
            ...Object.values(BRAND_ACCENTS).map((a) => ({ name: a.name, label: a.label, color: a.swatch })),
            ...accentOptions.map((a) => ({ name: a.name, label: a.label, color: accentSteps(a, 'light')[8]! })),
          ].map((option) => (
            <button
              key={option.name}
              type="button"
              role="radio"
              aria-checked={accent === option.name}
              aria-label={option.label}
              title={option.label}
              className="accentSwatch"
              data-selected={accent === option.name || undefined}
              style={{ background: option.color }}
              onClick={() => update({ accent: option.name })}
            />
          ))}
        </div>
      </div>
      <div className="prefsSection">
        <Label>Card style</Label>
        {/* The four library doors, dressed six ways. The same six the card lab
            offers - this is the plain door to it, for people who are never
            going to knock seven times on the wordmark. */}
        <CardStyleSection count={tracks.length} />
      </div>
      <div className="prefsSection">
        <Label>Size</Label>
        {/* One control for the whole interface. It moves the root font size,
            which every rem in the app hangs off - spacing, radii, type, the
            cards - so everything grows together instead of type swelling
            inside boxes that stayed put. Steps, not a slider: each of these
            has been looked at. */}
        <SegmentedControl
          aria-label="Interface size"
          fullWidth
          value={String(clampScale(scale))}
          options={UI_SCALES.map((value) => ({
            value: String(value),
            label: value === 1 ? 'Default' : `${Math.round(value * 100)}%`,
          }))}
          onValueChange={(next) => update({ scale: clampScale(Number(next)) })}
        />
        <Text tone="muted" size="sm">
          Scales the whole interface - text, artwork, controls and spacing alike.
        </Text>
      </div>
      <div className="prefsSection">
        <Label>Spacing</Label>
        <DensitySelector
          aria-label="Spacing"
          value={density}
          onValueChange={(next) => update({ density: next })}
        />
        <Text tone="muted" size="sm">
          How tightly things pack together, at whatever size you have chosen.
        </Text>
      </div>
    </div>
  );
}
