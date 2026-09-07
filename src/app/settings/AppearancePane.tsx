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
import { fireNativeHaptic, hapticsAvailable, setHapticsPref, useHapticsPref } from '../core/haptics.ts';
import {
  motionGesturesEnabled,
  nowPlayingVideoEnabled,
  setMotionGestures,
  setNowPlayingVideo,
} from './behaviourPrefs.ts';
import { askMotionAccess, motionAvailable } from '../player/deviceMotion.ts';
import { PaneSection, SettingRow } from './kit/settingsKit.tsx';
import { LOCALES, LOCALE_NAMES } from '../i18n/index.ts';
import { useAppLocale, useT } from '../i18n/LocaleShell.tsx';

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
  const { theme, accent, density, dynamicAccent, scale, update } = useAppearance();
  const { locale, setLocale } = useAppLocale();
  const t = useT();
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

  // The neutral themes' preview cards wear the LIVE accent - not a hardcoded
  // brand pink, which lied twice: it ignored a chosen kit accent, and it sat
  // still while the album colour repainted everything around it. As vars the
  // previews track whatever the primary colour is right now (song tint
  // included) and ride the same tween the rest of the app does.
  const livePreview = (palette: (typeof THEME_PRESETS)[number]['palette']) => ({
    ...palette,
    accent: 'var(--glacier-accent-solid)',
    accentSoft: 'var(--glacier-accent-soft)',
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
      {/* FIRST, above the theme. Everything below this is a preference about
          how the app looks; this one decides whether it can be read at all,
          and somebody who opened Settings because the app is in the wrong
          language should not have to scroll past six pickers to fix it.

          Each language is written IN that language, so the row you need is
          the one you can read. */}
      <PaneSection
        title={t('settings.language')}
        footer={t('settings.languageFooter')}
      >
        <div className="setk-row">
          <Select
            aria-label={t('settings.language')}
            fullWidth
            value={locale}
            onValueChange={(next) => void setLocale(next as typeof locale)}
            options={LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))}
          />
        </div>
      </PaneSection>

      <PaneSection title={t('settings.theme')}>
        <div className="setk-row">
          <ThemeSelector
            aria-label={t('settings.theme')}
            value={theme}
            leadFirst
            options={shown.map((preset) => {
              const neutral = NEUTRAL.includes(preset.id);
              return {
                value: preset.id,
                palette: neutral ? livePreview(preset.palette) : preset.palette,
                alternatePalette:
                  preset.id === 'system' && preset.alternatePalette
                    ? livePreview(preset.alternatePalette)
                    : preset.alternatePalette,
                // Resolved here rather than carried in THEME_COPY: the map is
                // built at import, so its words would be the ones the app
                // booted with.
                label: t(THEME_COPY[preset.id].labelKey),
                description: t(THEME_COPY[preset.id].descriptionKey),
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

      <PaneSection title={t('settings.accent')}>
        <div className="setk-row">
          <div className="accentSwatches" role="radiogroup" aria-label={t('settings.accentColour')}>
            {/* Brand accents first, then the kit's own. */}
            {[
              ...Object.values(BRAND_ACCENTS).map((a) => ({ name: a.name, label: t(a.labelKey), color: a.swatch })),
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
        <SettingRow
          id="dynamic-accent"
          label={t('settings.albumColour')}
          hint={t('settings.albumColourHint')}
          control={
            <Switch
              aria-label={t('settings.albumColour')}
              checked={dynamicAccent}
              onCheckedChange={(on: boolean) => update({ dynamicAccent: on })}
            />
          }
        />
      </PaneSection>

      <PaneSection title={t('settings.cardStyle')}>
        {/* The four library doors, dressed four ways. This is the only door to
            the choice now: the card lab that held the other thirty-two
            directions was a workshop for picking, and the picking is done. */}
        <div className="setk-row">
          <CardStyleSection
            count={tracks.length}
            covers={tracks.map((t) => t.artwork).filter((a): a is string => !!a)}
          />
        </div>
      </PaneSection>

      <PaneSection
        title={t('settings.size')}
        footer={t('settings.sizeFooter')}
      >
        {/* One control for the whole interface. It moves the root font size,
            which every rem in the app hangs off - spacing, radii, type, the
            cards - so everything grows together instead of type swelling
            inside boxes that stayed put. Steps, not a slider: each of these
            has been looked at. */}
        <div className="setk-row">
          <SegmentedControl
            aria-label={t('settings.interfaceSize')}
            fullWidth
            value={String(clampScale(scale))}
            options={UI_SCALES.map((value) => ({
              value: String(value),
              label: value === 1 ? t('settings.sizeDefault') : `${Math.round(value * 100)}%`,
            }))}
            onValueChange={(next) => update({ scale: clampScale(Number(next)) })}
          />
        </div>
      </PaneSection>

      <PaneSection
        title={t('settings.spacing')}
        footer={t('settings.spacingFooter')}
      >
        <div className="setk-row">
          <DensitySelector
            aria-label={t('settings.spacing')}
            value={density}
            onValueChange={(next) => update({ density: next })}
          />
        </div>
      </PaneSection>

      <PaneSection title={t('settings.nowPlaying')}>
        <SettingRow
          label={t('settings.headerLyrics')}
          hint={t('settings.headerLyricsHint')}
          layout="stacked"
          control={
            <Select
              aria-label={t('settings.headerLyrics')}
              fullWidth
              value={pb.lyricWay}
              onValueChange={(next) => pb.update({ lyricWay: next as typeof pb.lyricWay })}
              options={[
                { value: 'off', label: t('settings.lyricWayOff') },
                { value: 'random', label: t('settings.lyricWayRandom') },
                { value: 'scatter', label: t('settings.lyricWayScatter') },
                { value: 'typewriter', label: t('settings.lyricWayTypewriter') },
                { value: 'poster', label: t('settings.lyricWayPoster') },
                { value: 'stack', label: t('settings.lyricWayStack') },
              ]}
            />
          }
        />
        <SettingRow
          id="now-playing-video"
          label={t('settings.videoClips')}
          hint={t('settings.videoClipsHint')}
          control={
            <Switch
              aria-label={t('settings.videoClips')}
              checked={video}
              onCheckedChange={(on: boolean) => {
                setNowPlayingVideo(on);
                setVideo(on);
              }}
            />
          }
        />
      </PaneSection>

      <PaneSection title={t('settings.feel')}>
        {/*
          * Only where there is a motor.
          *
          * This preference SYNCS (prefsSync SYNCED_KEYS), and desktop has no
          * haptics at all - so an unconditional row let somebody turn off a
          * switch that did nothing on the machine in front of them and silence
          * every tick on their phone. Its sibling below has always asked
          * motionAvailable() the same question.
          */}
        {hapticsAvailable() && (
        <SettingRow
          id="haptics"
          label={t('settings.haptics')}
          hint={t('settings.hapticsHint')}
          control={
            <Switch
              aria-label={t('settings.haptics')}
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
        )}
        {motionAvailable() && (
          <SettingRow
            id="shake-flick"
            label={t('settings.shakeFlick')}
            hint={t('settings.shakeFlickHint')}
            control={
              <Switch
                aria-label={t('settings.shakeFlick')}
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
