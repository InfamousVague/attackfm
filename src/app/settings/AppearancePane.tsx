import { DensitySelector, SegmentedControl, Select, Switch } from '@glacier/react';
import { accentOptions, accentSteps } from '@glacier/tokens';
import { useState } from 'react';
import { BRAND_ACCENTS } from './brandAccents.ts';
import { clampScale, UI_SCALES, useAppearance } from './appearance.tsx';
import { ThemeSelector } from './ThemeSelector.tsx';
import { getThemePreset, THEME_PRESETS } from './themePresets.ts';
import { THEME_COPY } from './settingsShared.ts';
import { CardStyleSection } from './CardStylePicker.tsx';
import { useLibrary } from '../library/library.tsx';
import { usePlayback } from '../player/playback.tsx';
import { fireNativeHaptic, setHapticsPref, useHapticsPref } from '../core/haptics.ts';
import {
  motionGesturesEnabled,
  nowPlayingVideoEnabled,
  setMotionGestures,
  setNowPlayingVideo,
} from './behaviourPrefs.ts';
import { askMotionAccess, motionAvailable } from '../player/deviceMotion.ts';
import { PaneSection, SettingRow } from './kit/settingsKit.tsx';

/**
 * The appearance controls: the theme, accent, and spacing pulled from the
 * GlacierUI docs, each wired to the document root through the appearance store.
 *
 * ThemeSelector and CardStyleSection keep their own bodies rather than being
 * rebuilt on OptionCards: their selected-state language (accent border, ring,
 * filled check) is the language OptionCards was modelled ON, and the theme
 * previews paint live palettes that a generic card has no business knowing
 * about. The accent swatches keep their dots and double-ring - a colour is
 * its own best preview, and a labelled card per colour would say less with
 * more. Both exceptions are sanctioned in the kit's look rules.
 */
export function Appearance() {
  const { theme, accent, density, scale, update } = useAppearance();
  // Only for the preview's count line, so the sample card says something true.
  const { tracks } = useLibrary();
  // Now Playing's dress and the app's feel, moved in from Playback: the lyric
  // header, the looping clips, haptics and the motion gestures are all about
  // how the app LOOKS AND FEELS, not how music plays. Same stores as before -
  // only the address changed.
  const pb = usePlayback();
  const [video, setVideo] = useState(nowPlayingVideoEnabled);
  const hapticsOn = useHapticsPref();
  const [motion, setMotion] = useState(motionGesturesEnabled);

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
      <PaneSection title="Theme">
        <div className="setk-row">
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
      </PaneSection>

      <PaneSection title="Accent">
        <div className="setk-row">
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
      </PaneSection>

      <PaneSection title="Card style">
        {/* The four library doors, dressed six ways. The same six the card lab
            offers - this is the plain door to it, for people who are never
            going to knock seven times on the wordmark. */}
        <div className="setk-row">
          <CardStyleSection
            count={tracks.length}
            covers={tracks.map((t) => t.artwork).filter((a): a is string => !!a)}
          />
        </div>
      </PaneSection>

      <PaneSection
        title="Size"
        footer="Scales the whole interface — text, artwork, controls and spacing alike."
      >
        {/* One control for the whole interface. It moves the root font size,
            which every rem in the app hangs off - spacing, radii, type, the
            cards - so everything grows together instead of type swelling
            inside boxes that stayed put. Steps, not a slider: each of these
            has been looked at. */}
        <div className="setk-row">
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
        </div>
      </PaneSection>

      <PaneSection
        title="Spacing"
        footer="How tightly things pack together, at whatever size you have chosen."
      >
        <div className="setk-row">
          <DensitySelector
            aria-label="Spacing"
            value={density}
            onValueChange={(next) => update({ density: next })}
          />
        </div>
      </PaneSection>

      <PaneSection title="Now Playing">
        <SettingRow
          label="Lyrics in the header"
          hint="How the song's words are spelled across the artwork behind the header, when the track has synced lyrics. Random draws a new one each song."
          layout="stacked"
          control={
            <Select
              aria-label="Header lyrics"
              fullWidth
              value={pb.lyricWay}
              onValueChange={(next) => pb.update({ lyricWay: next as typeof pb.lyricWay })}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'random', label: 'Random each song' },
                { value: 'scatter', label: 'Scatter — words drift and dissolve' },
                { value: 'typewriter', label: 'Typewriter — typed in the corner' },
                { value: 'poster', label: 'Poster — fills the header, packed' },
                { value: 'stack', label: 'Stack — a column of capitals' },
              ]}
            />
          }
        />
        <SettingRow
          id="now-playing-video"
          label="Video clips on Now Playing"
          hint="Plays the song's short looping clip behind the full player. Each new song pulls down a few megabytes of video, and your server asks Spotify for it by song title. Off leaves the blurred cover."
          control={
            <Switch
              aria-label="Video clips on Now Playing"
              checked={video}
              onCheckedChange={(on: boolean) => {
                setNowPlayingVideo(on);
                setVideo(on);
              }}
            />
          }
        />
      </PaneSection>

      <PaneSection title="Feel">
        <SettingRow
          label="Haptics"
          hint="Ticks from the Taptic Engine as you tap, play, and spin the disc. Only things you actually press answer - scrolling and loading stay silent."
          control={
            <Switch
              aria-label="Haptics"
              checked={hapticsOn}
              onCheckedChange={(on) => {
                setHapticsPref(on);
                // A goodbye you can feel; nothing when turning ON from off,
                // because the provider has not re-enabled yet this frame.
                if (on) window.setTimeout(() => fireNativeHaptic('light'), 50);
              }}
            />
          }
        />
        {motionAvailable() && (
          <SettingRow
            label="Shake and flick"
            hint="On the Now Playing screen: shake to change shuffle, flick left or right to move between songs. Off by default because a gesture that misreads costs you the song you were listening to — walking, running and a pocket are all ignored, but a phone that lives in a bag may still find a way."
            control={
              <Switch
                aria-label="Shake and flick"
                checked={motion}
                onCheckedChange={(on) => {
                  // iOS only grants motion access from inside a real gesture,
                  // and this switch IS one - asking anywhere else is refused
                  // with no prompt shown, which reads as the switch not
                  // working.
                  if (on) {
                    void askMotionAccess().then((ok: boolean) => {
                      if (!ok) {
                        setMotionGestures(false);
                        setMotion(false);
                      }
                    });
                  }
                  setMotionGestures(on);
                  setMotion(on);
                }}
              />
            }
          />
        )}
      </PaneSection>
    </div>
  );
}
