import {
  Button,
  DensitySelector,
  Field,
  Input,
  Label,
  SegmentedControl,
  Slider,
  Switch,
  TabbedModal,
  Text,
} from '@glacier/react';
import { accentOptions, accentSteps } from '@glacier/tokens';
import { Blocks, FolderOpen, Info, Play, Settings, SlidersHorizontal } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { BRAND_ACCENTS } from './brandAccents.ts';
import { useAppearance } from './appearance.tsx';
import { canPickFolder } from './tauri.ts';
import { useLibrary } from './library.tsx';
import { usePlayback, type SleepTimer } from './playback.tsx';
import { usePlugins, usePluginSettingsSections } from '../plugins/runtime.tsx';
import { ThemeSelector } from './ThemeSelector.tsx';
import { getThemePreset, THEME_PRESETS, type ThemePreference } from './themePresets.ts';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

// The name and one-line gloss for each theme, keyed by preset id.
const THEME_COPY: Record<ThemePreference, { label: string; description: string }> = {
  system: { label: 'Automatic', description: 'Follows the system.' },
  light: { label: 'Alpine', description: 'Bright and neutral.' },
  dark: { label: 'Midnight', description: 'Dim and neutral.' },
  dawn: { label: 'Dawn', description: 'Warm light.' },
  boreal: { label: 'Boreal', description: 'Cool dark.' },
  ember: { label: 'Ember', description: 'Warm dark.' },
};

/**
 * The appearance controls: the theme, accent, and spacing pulled from the
 * GlacierUI docs, each wired to the document root through the appearance store.
 */
function Appearance() {
  const { theme, accent, density, update } = useAppearance();

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

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Label>Theme</Label>
        <ThemeSelector
          aria-label="Theme"
          value={theme}
          options={THEME_PRESETS.map((preset) => {
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
        <Label>Spacing</Label>
        <DensitySelector
          aria-label="Spacing"
          value={density}
          onValueChange={(next) => update({ density: next })}
        />
      </div>
    </div>
  );
}

/**
 * The General controls. For now that is where music lives: the app resolves a
 * default AttackFM folder under the OS audio directory, and this lets the user
 * point it somewhere else. The chosen folder is the global source the library
 * is built from and played through.
 */
function General() {
  const { musicDir, loading, isDefault, choose, reset } = useLibrary();

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Field
          label="Music folder"
          hint={
            canPickFolder
              ? 'Where AttackFM looks for music to build the library from.'
              : 'The folder can only be changed in the desktop app.'
          }
        >
          <Input
            readOnly
            value={loading ? 'Locating…' : musicDir}
            aria-label="Music folder"
            leadingIcon={<FolderOpen size={16} />}
          />
        </Field>
        {canPickFolder && (
          <div className="prefsActions">
            <Button variant="outline" size="sm" onClick={() => void choose()}>
              Choose folder…
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={isDefault}
              onClick={() => void reset()}
            >
              Reset to default
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// The sections down the side. Appearance, General, and Playback are wired up;
// the copy names what the others will hold.
const PLACEHOLDERS = [
  { id: 'about', label: 'About', icon: <Info size={16} />, blurb: 'Version, licences, and the credits for what is playing.' },
];

/** The sleep timer's countdown, ticking once a second while one is armed. */
function SleepCountdown({ sleep }: { sleep: SleepTimer }) {
  const [now, setNow] = useState(() => Date.now());
  const running = sleep !== null && sleep !== 'end-of-track';
  useEffect(() => {
    if (!running) return;
    // Fresh before the first paint too: the state's initial reading is from
    // whenever this component mounted, which may be minutes stale by the time
    // a timer is armed.
    setNow(Date.now());
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [running]);
  if (sleep === null) return null;
  if (sleep === 'end-of-track') {
    return (
      <Text tone="muted" size="sm">
        Playback stops when the current track ends.
      </Text>
    );
  }
  const remaining = Math.max(0, sleep.at - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return (
    <Text tone="muted" size="sm">
      Playback stops in {minutes}:{String(seconds).padStart(2, '0')}.
    </Text>
  );
}

/**
 * The playback behaviours: how songs hand over to each other, what shuffle
 * avoids, what a pause sounds like, how the sound is shaped, and when the
 * music should put itself to bed. All of it lives in the playback context the
 * player reads, so every control here takes effect mid-song.
 */
function PlaybackSettings() {
  const pb = usePlayback();

  const sleepValue =
    pb.sleep === null ? 'off' : pb.sleep === 'end-of-track' ? 'end' : String(pb.sleep.minutes);
  const setSleepChoice = (choice: string) => {
    if (choice === 'off') pb.setSleep(null);
    else if (choice === 'end') pb.setSleep('end-of-track');
    else {
      const minutes = Number(choice);
      pb.setSleep({ at: Date.now() + minutes * 60_000, minutes });
    }
  };

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Field
          label="Crossfade"
          hint="Blends the end of one song into the start of the next. Automatic changes only - skips stay immediate."
        >
          <div className="prefsSliderRow">
            <Slider
              aria-label="Crossfade length"
              min={0}
              max={12}
              step={1}
              value={pb.crossfade}
              onValueChange={(next) => pb.update({ crossfade: next })}
            />
            <Text size="sm" tone="muted" mono className="prefsSliderValue">
              {pb.crossfade === 0 ? 'Off' : `${pb.crossfade}s`}
            </Text>
          </div>
        </Field>
      </div>
      <div className="prefsSection">
        <Field label="Pause" hint="What pressing pause sounds like.">
          <SegmentedControl
            aria-label="Pause style"
            value={pb.pauseStyle}
            onValueChange={(next) => pb.update({ pauseStyle: next as typeof pb.pauseStyle })}
            options={[
              { value: 'turntable', label: 'Turntable' },
              { value: 'fade', label: 'Fade' },
              { value: 'instant', label: 'Cut' },
            ]}
          />
        </Field>
      </div>
      <div className="prefsSection">
        <Label>Queue</Label>
        <Switch
          label="Smart shuffle"
          checked={pb.smartShuffle}
          onCheckedChange={(on) => pb.update({ smartShuffle: on })}
        />
        <Text tone="muted" size="sm">
          Shuffle avoids playing the same artist twice in a row, and steers around songs it just
          played.
        </Text>
        <Switch
          label="Auto DJ"
          checked={pb.autoDj}
          onCheckedChange={(on) => pb.update({ autoDj: on })}
        />
        <Text tone="muted" size="sm">
          When the queue runs out, keeps playing similar songs from the library instead of stopping.
        </Text>
      </div>
      <div className="prefsSection">
        <Label>Sound</Label>
        <Switch
          label="Night mode"
          checked={pb.nightMode}
          onCheckedChange={(on) => pb.update({ nightMode: on })}
        />
        <Text tone="muted" size="sm">
          Evens out loud and quiet passages, for listening at low volume without riding the fader.
        </Text>
        <Switch label="Mono" checked={pb.mono} onCheckedChange={(on) => pb.update({ mono: on })} />
        <Text tone="muted" size="sm">
          Plays the same signal to both ears - for single-earbud listening, or hearing comfort.
        </Text>
      </div>
      <div className="prefsSection">
        <Field label="Sleep timer" hint="Fades out and pauses when the time is up. Cleared on relaunch.">
          <SegmentedControl
            aria-label="Sleep timer"
            value={sleepValue}
            onValueChange={setSleepChoice}
            options={[
              { value: 'off', label: 'Off' },
              { value: '15', label: '15m' },
              { value: '30', label: '30m' },
              { value: '45', label: '45m' },
              { value: '60', label: '1h' },
              { value: 'end', label: 'Track end' },
            ]}
          />
        </Field>
        <SleepCountdown sleep={pb.sleep} />
      </div>
    </div>
  );
}

/**
 * The switchboard: every registered plugin, on or off, with crash notices.
 * Core rather than a contribution, so the toggle UI cannot vanish when the
 * plugin being toggled owns the selected section.
 */
function PluginsSettings() {
  const { all, isEnabled, setEnabled, failures } = usePlugins();
  return (
    <div className="prefsBody">
      {all.map((p) => {
        const failure = failures.get(p.id);
        return (
          <div key={p.id} className="prefsSection">
            <Switch
              label={p.name}
              // The switch is the user's setting, not the running state: a
              // crashed plugin stays checked and says so below, so one flip
              // OFF turns it off for good rather than retrying it first.
              // Either flip clears the crash flag, so off-and-on is the retry.
              checked={isEnabled(p.id)}
              onCheckedChange={(on) => setEnabled(p.id, on)}
            />
            <Text tone="muted" size="sm">
              {failure !== undefined
                ? `Crashed this session (${failure}). Switch off and on to try again.`
                : p.description}
            </Text>
          </div>
        );
      })}
      <div className="prefsSection">
        <Text tone="muted" size="sm">
          Toggles apply immediately; switching a plugin may briefly restart playback.
          Work a plugin already handed to the app&rsquo;s engine - queued downloads,
          say - carries on in the background without its controls until it is
          switched back on.
        </Text>
      </div>
    </div>
  );
}

/**
 * The settings surface. TabbedModal is the kit's settings dialog - a section
 * rail beside a scrolling pane, on top of Modal - so this only supplies the
 * sections.
 */
export function SettingsModal({ open, onClose }: SettingsModalProps) {
  // Static data only - no plugin hooks - so no scope is needed here, and the
  // modal survives a toggle without remounting out from under the user.
  const pluginSections = usePluginSettingsSections();

  const sections = [
    {
      id: 'appearance',
      label: 'Appearance',
      icon: <SlidersHorizontal size={16} />,
      content: <Appearance />,
    },
    {
      id: 'general',
      label: 'General',
      icon: <Settings size={16} />,
      content: <General />,
    },
    {
      id: 'playback',
      label: 'Playback',
      icon: <Play size={16} />,
      content: <PlaybackSettings />,
    },
    // The importer contributes Downloads here, exactly where it has always
    // sat; any plugin's tabs land in this run of the rail.
    ...pluginSections,
    {
      id: 'plugins',
      label: 'Plugins',
      icon: <Blocks size={16} />,
      content: <PluginsSettings />,
    },
    ...PLACEHOLDERS.map((s) => ({
      id: s.id,
      label: s.label,
      icon: s.icon,
      content: <Text tone="muted">{s.blurb}</Text>,
    })),
  ];

  // The tab is controlled so a section that leaves the rail - a plugin pulled
  // after a crash while its own tab is showing - cannot strand the modal on an
  // id that no longer exists (the kit renders no pane at all for one). The
  // reset lands on Plugins, where the crash notice explains what just left.
  const [tab, setTab] = useState('appearance');
  const sectionIds = sections.map((s) => s.id).join('\n');
  useEffect(() => {
    if (!sectionIds.split('\n').includes(tab)) setTab('plugins');
  }, [sectionIds, tab]);

  return (
    <TabbedModal
      open={open}
      onClose={onClose}
      title="Settings"
      value={tab}
      onValueChange={setTab}
      // The rail and the pane read as one surface here, so the line between them
      // is dropped.
      divider={false}
      sections={sections}
    />
  );
}
