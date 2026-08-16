import {
  Button,
  Card,
  DensitySelector,
  Field,
  Input,
  Label,
  Modal,
  Pill,
  SegmentedControl,
  Select,
  Slider,
  Spinner,
  StatTile,
  Switch,
  TabbedModal,
  Text,
} from '@glacier/react';
import { accentOptions, accentSteps } from '@glacier/tokens';
import {
  Blocks,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Disc3,
  FolderOpen,
  HardDrive,
  Info,
  LogOut,
  Mic2,
  Bell,
  MonitorSpeaker,
  Music,
  Palette,
  Play,
  Server,
  Settings,
  Sparkles,
  Timer,
  Trash2,
  X,
} from '@glacier/icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { APP_VERSION } from './version.ts';
import { fireNativeHaptic, setHapticsPref, useHapticsPref } from './haptics.ts';
import type { Plugin } from '../plugins/types.ts';
import {
  addSource,
  fetchManifest,
  installPlugin,
  readSources,
  removeSource,
  uninstallPlugin,
  type RemoteManifest,
  type RemotePluginListing,
} from '../plugins/remote.ts';
import { BRAND_ACCENTS } from './brandAccents.ts';
import { clampScale, UI_SCALES, useAppearance } from './appearance.tsx';
import { canPickFolder, isTauri } from './tauri.ts';
import { useLibrary } from './library.tsx';
import { onlineMetadataEnabled, setOnlineMetadata } from './netPrefs.ts';
import { usePlayback, type SleepTimer } from './playback.tsx';
import { usePlugins, usePluginSettingsSections } from '../plugins/runtime.tsx';
import { AboutSettings } from './AboutSettings.tsx';
import { NotificationSettings } from './NotificationSettings.tsx';
import { DevicesSettings } from './DevicesSettings.tsx';
import { CuratorSettings } from './CuratorSettings.tsx';
import { useConnect } from './playbackSync.tsx';
import { useServerSession } from './serverSession.tsx';
import { DeviceStorageSettings } from './DeviceStorageSettings.tsx';
import { ServersSettings } from './ServersSettings.tsx';
import { knownServers } from './servers.ts';
import { heldCount, offlineSpace, onOfflineChange } from './offline.ts';
import { ThemeSelector } from './ThemeSelector.tsx';
import { getThemePreset, THEME_PRESETS, type ThemePreference } from './themePresets.ts';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
}

/** Same coarse/narrow signal the player folds its rails on, so Settings turns
 *  into the touch drill-in exactly where the rest of the mobile chrome does. */
// Coarse pointer alone is not "phone": an unfolded foldable is all thumb and
// 840px wide, and the full-screen drill-in wastes that room. The phone
// treatment now requires the screen to actually be narrow; a wide touch
// screen gets the desktop modal, rail and all.
const MOBILE_QUERY = '(pointer: coarse) and (max-width: 699px), (max-width: 540px)';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    // Some embedded webviews resize without firing the mql change; the resize
    // listener re-asks the same question for those, and costs nothing elsewhere.
    window.addEventListener('resize', onChange);
    return () => {
      mql.removeEventListener('change', onChange);
      window.removeEventListener('resize', onChange);
    };
  }, [query]);
  return matches;
}

/** One entry in the settings rail: an id, its label, its icon, its pane -
 * plus what the phone's drill-in list needs: a one-line reading of the
 * section's current state, a tint for its icon chip, and which cluster of
 * rows it files under. */
interface SettingsSection {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
  /** The row's second line on the touch list, e.g. "Midnight · Attack". */
  summary?: string;
  /** The icon chip's colour family on the touch list. */
  tint?: 'pink' | 'blue' | 'green' | 'orange' | 'purple' | 'slate';
  /** Rows with the same group cluster into one card on the touch list. */
  group?: number;
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
  const { theme, accent, density, scale, update } = useAppearance();

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

/**
 * The General controls. For now that is where music lives: the app resolves a
 * default AttackFM folder under the OS audio directory, and this lets the user
 * point it somewhere else. The chosen folder is the global source the library
 * is built from and played through.
 */
function General() {
  const { source, musicDir, loading, isDefault, choose, reset, tracks } = useLibrary();
  const { session, disconnect } = useServerSession();
  // A module-level pref rather than context: the two consumers are plain
  // async functions, so the switch just re-reads on each render.
  const [online, setOnline] = useState(onlineMetadataEnabled);

  // The library, counted: what the folder (or the server) amounts to.
  const libStats = useMemo(() => {
    const artists = new Set<string>();
    const albums = new Set<string>();
    let seconds = 0;
    for (const t of tracks) {
      if (t.artist) artists.add(t.artist);
      if (t.album) albums.add(`${t.artist}\u0000${t.album}`);
      seconds += t.duration ?? 0;
    }
    return { artists: artists.size, albums: albums.size, hours: Math.round(seconds / 3600) };
  }, [tracks]);

  const onlineSwitch = (
    <div className="prefsSection">
      <Label>Privacy</Label>
      <Switch
        label="Online metadata lookups"
        checked={online}
        onCheckedChange={(on) => {
          setOnlineMetadata(on);
          setOnline(on);
        }}
      />
      <Text tone="muted" size="sm">
        Fetches lyrics from LRCLIB and album art from Apple, keyed by track titles.
        Off keeps the app entirely between your devices and your own server.
      </Text>
    </div>
  );

  // Remove the signed-in account from this device. `disconnect` clears the
  // stored session (so the app is signed out here) and best-effort tells the
  // server to drop the token — the library, downloads and playlists all stay
  // on the server, so signing back in restores them.
  const accountSection = session ? (
    <div className="prefsSection">
      <Label>Account</Label>
      <Text tone="muted" size="sm">
        Signed in as {session.username} on {session.url.replace(/^https?:\/\//, '')}.
      </Text>
      <div className="prefsActions">
        <Button variant="outline" size="sm" onClick={() => void disconnect()}>
          <LogOut size={14} /> Log out
        </Button>
      </div>
      <Text tone="muted" size="sm">
        Removes this account from this device. Your music stays on the server —
        sign in again to reach it here.
      </Text>
    </div>
  ) : null;

  const statsGrid = (
    <div className="prefsSection">
      <Label>Your library</Label>
      <div className="libraryStats">
        <StatTile icon={<Music size={16} />} value={tracks.length.toLocaleString()} label="Songs" />
        <StatTile icon={<Mic2 size={16} />} value={libStats.artists.toLocaleString()} label="Artists" />
        <StatTile icon={<Disc3 size={16} />} value={libStats.albums.toLocaleString()} label="Albums" />
        <StatTile icon={<Timer size={16} />} value={libStats.hours.toLocaleString()} label="Hours" />
      </div>
    </div>
  );

  // A connected server IS the library, so the folder picker would be pointing
  // at something nothing is playing from. Say where the music is coming from
  // instead, and send the user to the pane that can change it.
  if (source === 'server') {
    return (
      <div className="prefsBody">
        {statsGrid}
        <div className="prefsSection">
          <Field
            label="Music library"
            hint="The library is coming from a server. Change or disconnect it under Server."
          >
            <Input readOnly value={musicDir} aria-label="Music library" leadingIcon={<Cloud size={16} />} />
          </Field>
        </div>
        {onlineSwitch}
        {accountSection}
      </div>
    );
  }

  return (
    <div className="prefsBody">
      {statsGrid}
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
      {onlineSwitch}
      {accountSection}
    </div>
  );
}

/** The accent slug's human name, brand accents first, kit accents after. */
function accentLabel(accent: string): string {
  const brand = Object.values(BRAND_ACCENTS).find((a) => a.name === accent);
  if (brand) return brand.label;
  return accentOptions.find((a) => a.name === accent)?.label ?? accent;
}

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
  const hapticsOn = useHapticsPref();

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
            // The section stretches the control to the pane's width already,
            // so the segments must split that width rather than pack left.
            fullWidth
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
        <Field
          label="Lyrics in the header"
          hint="How the song's words are spelled across the artwork behind the header, when the track has synced lyrics. Random draws a new one each song."
        >
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
        <Switch
          label="Volume boost range"
          checked={pb.volumeBoost}
          onCheckedChange={(on) => pb.update({ volumeBoost: on })}
        />
        <Text tone="muted" size="sm">
          Lets the fader push past 100% for quiet recordings. Off caps it at unity - kinder to
          ears and speakers.
        </Text>
      </div>
      <div className="prefsSection">
        <Label>Feel</Label>
        <Switch
          label="Haptics"
          checked={hapticsOn}
          onCheckedChange={(on) => {
            setHapticsPref(on);
            // A goodbye you can feel; nothing when turning ON from off,
            // because the provider has not re-enabled yet this frame.
            if (on) window.setTimeout(() => fireNativeHaptic('light'), 50);
          }}
        />
        <Text tone="muted" size="sm">
          Ticks from the Taptic Engine as you tap, play, and spin the disc. Only things you
          actually press answer - scrolling and loading stay silent.
        </Text>
      </div>
      <div className="prefsSection">
        <Label>History</Label>
        <Switch
          label="Save listening history"
          checked={pb.saveHistory}
          onCheckedChange={(on) => pb.update({ saveHistory: on })}
        />
        <Text tone="muted" size="sm">
          Reports finished listens to your server - it is what feeds the Home page&rsquo;s
          recently-played shelves and your mixes. Off, nothing is written anywhere.
        </Text>
      </div>
      <div className="prefsSection">
        <Field label="Sleep timer" hint="Fades out and pauses when the time is up. Cleared on relaunch.">
          <SegmentedControl
            aria-label="Sleep timer"
            fullWidth
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
 * What a plugin adds to the app, read off the plugin object itself rather
 * than declared in its listing - contributions derived from the contract
 * cannot drift from what actually mounts.
 */
function pluginContributions(p: Plugin): string[] {
  return [
    ...(p.slots?.['titlebar-end'] ? ['A title bar button'] : []),
    ...(p.slots?.['player-trailing'] ? ['A player strip control'] : []),
    ...(p.settingsSections?.length
      ? [`A settings tab: ${p.settingsSections.map((s) => s.label).join(', ')}`]
      : []),
    ...(p.playlistTiles?.length ? ['Playlist tiles on the home strip'] : []),
    ...(p.downloads?.length ? ['A queue on the Downloads page'] : []),
    ...(p.usePaletteCommands ? ['Command palette actions'] : []),
    ...(p.Provider ? ['A background service while enabled'] : []),
  ];
}

/**
 * One listing on the marketplace shelf. The whole card is a doorway to the
 * detail dialog - a stretched button behind the content, so the card stays a
 * plain div and the switch a sibling above it, never a control nested inside
 * a control - while the switch flips the plugin without opening anything.
 */
function PluginCard({
  plugin,
  enabled,
  crashed,
  onToggle,
  onOpen,
}: {
  plugin: Plugin;
  enabled: boolean;
  crashed: boolean;
  onToggle: (on: boolean) => void;
  onOpen: () => void;
}) {
  return (
    <Card interactive className="pluginCard">
      <button
        type="button"
        className="pluginCardOpen"
        aria-label={`About ${plugin.name}`}
        onClick={onOpen}
      />
      <div className="pluginCardTop">
        <span className="pluginCardIcon" aria-hidden="true">
          {plugin.icon ?? <Blocks size={22} />}
        </span>
        {/* Above the doorway, so a flip is a flip and never a navigation. */}
        <span className="pluginCardSwitch">
          <Switch
            aria-label={`Enable ${plugin.name}`}
            checked={enabled}
            onCheckedChange={onToggle}
          />
        </span>
      </div>
      <div className="pluginCardName">
        <Text weight="semibold">{plugin.name}</Text>
        {(plugin.author || plugin.version) && (
          <Text size="xs" tone="subtle">
            {[plugin.author, plugin.version].filter(Boolean).join(' · ')}
          </Text>
        )}
      </div>
      <Text size="sm" tone="muted" className="pluginCardBlurb">
        {plugin.description}
      </Text>
      <div className="pluginCardTags">
        {crashed && (
          <Pill size="sm" tone="danger">
            Crashed
          </Pill>
        )}
        {(plugin.tags ?? []).map((tag) => (
          <Pill key={tag} size="sm" tone="neutral">
            {tag}
          </Pill>
        ))}
      </div>
    </Card>
  );
}

/** The detail dialog's uninstall control: removes the stored bundle. */
function UninstallButton({
  pluginId,
  name,
  onDone,
}: {
  pluginId: string;
  name: string;
  onDone: () => void;
}) {
  const { reloadRemote } = usePlugins();
  return (
    <Button
      variant="danger"
      onClick={() => {
        uninstallPlugin(pluginId);
        reloadRemote();
        onDone();
      }}
      aria-label={`Uninstall ${name}`}
    >
      <Trash2 size={15} /> <span>Uninstall</span>
    </Button>
  );
}

/**
 * The repositories the marketplace pulls from, and what they offer.
 *
 * A repository is a URL serving a manifest of installable plugin bundles.
 * Installing downloads the code once and keeps it locally - from then on the
 * plugin loads at boot with no network - so a repository is a distribution
 * channel, not a dependency. Adding one is trusting its owner with code that
 * runs inside the app, and the confirm on Add says exactly that.
 */
/** A repository's fetched manifest, the reason it could not be read, or a wait. */
type Feed = RemoteManifest | string | 'loading';

function listingsOf(feed: Feed | undefined): RemotePluginListing[] {
  return typeof feed === 'object' && feed !== null && 'plugins' in feed ? feed.plugins : [];
}

/**
 * Dotted versions, newest wins. Only a STRICTLY higher version counts as an
 * update: comparing by inequality would nag forever about a repository that
 * happens to be pinned behind what is installed, and offer a "update" that
 * silently downgrades.
 */
function isNewer(candidate: string, installed: string): boolean {
  const parts = (v: string) => v.split(/[.\-+]/).map((n) => Number.parseInt(n, 10) || 0);
  const a = parts(candidate);
  const b = parts(installed);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * The repositories and what they are offering, fetched once for the whole
 * pane. Lifted out of the sources list because three surfaces need it now -
 * the update banner, the browse shelf and the sources tab - and three
 * independent fetches of the same manifests would be three times the traffic
 * and three chances to disagree about what is available.
 */
function useRepoFeeds() {
  const [sources, setSources] = useState<string[]>(readSources);
  const [feeds, setFeeds] = useState<Map<string, Feed>>(new Map());
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    setFeeds(new Map(sources.map((s) => [s, 'loading' as const])));
    for (const source of sources) {
      void fetchManifest(source, controller.signal)
        .then((manifest) => {
          if (!live) return;
          setFeeds((prev) => new Map(prev).set(source, manifest));
        })
        .catch((err) => {
          if (!live) return;
          setFeeds((prev) =>
            new Map(prev).set(source, err instanceof Error ? err.message : 'unreachable'),
          );
        });
    }
    return () => {
      live = false;
      controller.abort();
    };
  }, [sources, nonce]);

  return {
    sources,
    setSources,
    feeds,
    refresh: () => setNonce((n) => n + 1),
    loading: [...feeds.values()].some((f) => f === 'loading'),
  };
}

/** Installing, shared by every surface that offers it. */
function useInstaller(reloadRemote: () => void) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const install = async (source: string, listing: RemotePluginListing) => {
    setBusyId(listing.id);
    try {
      await installPlugin(source, listing);
      reloadRemote();
    } catch (err) {
      window.alert(
        `Could not install ${listing.name}: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      setBusyId(null);
    }
  };
  return { busyId, install };
}

/**
 * What is installed but out of date, above everything else. Nothing here
 * updates on its own - a plugin is code the user chose to run, so a new
 * version is an offer rather than something that happens to them - which is
 * exactly why it has to be visible without going looking for it.
 */
function PluginUpdates({
  updates,
  busyId,
  onUpdate,
}: {
  updates: Array<{ source: string; listing: RemotePluginListing; from: string }>;
  busyId: string | null;
  onUpdate: (source: string, listing: RemotePluginListing) => void;
}) {
  if (updates.length === 0) return null;
  return (
    <div className="pluginUpdates">
      <div className="pluginUpdatesHead">
        <Label>
          {updates.length === 1 ? '1 update available' : `${updates.length} updates available`}
        </Label>
        <Button
          variant="solid"
          size="sm"
          disabled={busyId !== null}
          onClick={() => {
            for (const u of updates) onUpdate(u.source, u.listing);
          }}
        >
          {updates.length === 1 ? 'Update' : 'Update all'}
        </Button>
      </div>
      {updates.map((u) => (
        <div key={u.listing.id} className="pluginUpdateRow">
          <div className="pluginRepoRowText">
            <Text size="sm">{u.listing.name}</Text>
            <Text size="xs" tone="muted">
              v{u.from} &rarr; v{u.listing.version}
            </Text>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={busyId === u.listing.id}
            onClick={() => onUpdate(u.source, u.listing)}
          >
            {busyId === u.listing.id ? 'Updating…' : 'Update'}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Everything the repositories offer that is not installed yet. */
function PluginBrowse({
  feeds,
  remoteInstalled,
  busyId,
  loading,
  onInstall,
}: {
  feeds: Map<string, Feed>;
  remoteInstalled: ReadonlyMap<string, { version: string }>;
  busyId: string | null;
  loading: boolean;
  onInstall: (source: string, listing: RemotePluginListing) => void;
}) {
  const offered = [...feeds.entries()].flatMap(([source, feed]) =>
    listingsOf(feed).map((listing) => ({ source, listing })),
  );
  // Two repositories offering the same plugin is one plugin, not two rows -
  // the official repo mirrors the private one, so without this every mirrored
  // plugin doubles. Newest version wins; a tie keeps the first source listed.
  const byId = new Map<string, { source: string; listing: RemotePluginListing }>();
  for (const offer of offered) {
    const seen = byId.get(offer.listing.id);
    if (!seen || isNewer(offer.listing.version, seen.listing.version)) byId.set(offer.listing.id, offer);
  }
  const available = [...byId.values()].filter(({ listing }) => !remoteInstalled.has(listing.id));

  if (available.length === 0) {
    return (
      <Text size="sm" tone="subtle">
        {loading
          ? 'Looking for plugins…'
          : offered.length === 0
            ? 'No repository is offering anything. Add one under Sources.'
            : 'Everything on offer is already installed.'}
      </Text>
    );
  }
  return (
    <div className="pluginBrowse">
      {available.map(({ source, listing }) => (
        <div key={`${source}/${listing.id}`} className="pluginRepoRow">
          <div className="pluginRepoRowText">
            <Text size="sm">
              {listing.name}{' '}
              <Text as="span" size="xs" tone="subtle">
                v{listing.version}
                {listing.author ? ` · ${listing.author}` : ''}
              </Text>
            </Text>
            <Text size="xs" tone="muted">
              {listing.description}
            </Text>
            <Text size="xs" tone="subtle">
              {source.replace(/^https?:\/\//, '')}
            </Text>
          </div>
          <Button
            variant="solid"
            size="sm"
            disabled={busyId === listing.id}
            onClick={() => onInstall(source, listing)}
          >
            {busyId === listing.id ? 'Installing…' : 'Install'}
          </Button>
        </div>
      ))}
    </div>
  );
}

/** Where plugins come from: the addresses themselves, and whether they answer. */
function PluginSources({
  sources,
  setSources,
  feeds,
  onRefresh,
}: {
  sources: string[];
  setSources: (next: string[]) => void;
  feeds: Map<string, Feed>;
  onRefresh: () => void;
}) {
  const [adding, setAdding] = useState('');
  return (
    <div className="pluginSources">
      <div className="spotifyAccountRow">
        <Text size="sm" tone="muted">
          Where the marketplace looks. Your own server hosts one at <code>/plugins</code>.
        </Text>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          Refresh
        </Button>
      </div>

      {sources.map((source) => {
        const feed = feeds.get(source);
        const count = listingsOf(feed).length;
        return (
          <div key={source} className="pluginRepo">
            <div className="pluginRepoHead">
              <Text size="sm" mono className="pluginRepoUrl">
                {source.replace(/^https?:\/\//, '')}
              </Text>
              {feed === 'loading' && <Spinner size="sm" />}
              {typeof feed === 'string' && feed !== 'loading' ? (
                <Pill size="sm" tone="danger">
                  {feed}
                </Pill>
              ) : (
                feed !== 'loading' && (
                  <Pill size="sm" tone="neutral">
                    {count === 1 ? '1 plugin' : `${count} plugins`}
                  </Pill>
                )
              )}
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Remove repository ${source}`}
                onClick={() => setSources(removeSource(source))}
              >
                Remove
              </Button>
            </div>
          </div>
        );
      })}
      {sources.length === 0 && (
        <Text size="xs" tone="subtle">
          No repositories yet.
        </Text>
      )}

      <div className="pluginRepoAdd">
        <Input
          value={adding}
          onChange={(e) => setAdding(e.currentTarget.value)}
          placeholder="plugins.example.com"
          aria-label="Repository address"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!adding.trim()}
          onClick={() => {
            // Adding a repository is trusting its owner with code that runs
            // inside the app - said out loud, once, at the moment it matters.
            const sure = window.confirm(
              'Plugins from a repository run inside AttackFM with the same access the app has. Only add repositories you trust.\n\nAdd this repository?',
            );
            if (!sure) return;
            setSources(addSource(adding));
            setAdding('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * The marketplace: every registered plugin as a card on a shelf, each opening
 * a detail dialog that says what it is, what it adds, and holds the switch.
 * Core rather than a contribution, so the shelf cannot vanish when the plugin
 * being toggled owns the selected section.
 */
function PluginsSettings() {
  const { all, isEnabled, setEnabled, failures, remoteInstalled, reloadRemote } = usePlugins();
  // The id, not the object: a plugin pulled mid-session closes its dialog
  // instead of showing a ghost of it.
  const [openId, setOpenId] = useState<string | null>(null);
  const [tab, setTab] = useState<'browse' | 'sources'>('browse');
  const open = all.find((p) => p.id === openId) ?? null;
  const openFailure = open ? failures.get(open.id) : undefined;
  const openRemote = open ? remoteInstalled.get(open.id) : undefined;
  const enabledCount = all.filter((p) => isEnabled(p.id)).length;

  const { sources, setSources, feeds, refresh, loading } = useRepoFeeds();
  const { busyId, install } = useInstaller(reloadRemote);

  // Installed plugins a repository is offering a higher version of. Computed
  // across every source, so a plugin that moved repositories still updates -
  // but one offer per plugin: mirrored repos would otherwise stack a banner
  // row for each copy. The highest version on offer wins.
  const updates = useMemo(() => {
    const found = new Map<string, { source: string; listing: RemotePluginListing; from: string }>();
    for (const [source, feed] of feeds) {
      for (const listing of listingsOf(feed)) {
        const installed = remoteInstalled.get(listing.id);
        if (!installed || !isNewer(listing.version, installed.version)) continue;
        const seen = found.get(listing.id);
        if (!seen || isNewer(listing.version, seen.listing.version)) {
          found.set(listing.id, { source, listing, from: installed.version });
        }
      }
    }
    return [...found.values()];
  }, [feeds, remoteInstalled]);

  return (
    <div className="prefsBody">
      <PluginUpdates updates={updates} busyId={busyId} onUpdate={(s, l) => void install(s, l)} />

      <SegmentedControl
        aria-label="Plugins view"
        fullWidth
        value={tab}
        onValueChange={(next) => setTab(next as typeof tab)}
        options={[
          { value: 'browse', label: 'Browse' },
          { value: 'sources', label: 'Sources' },
        ]}
      />

      {tab === 'browse' ? (
        <>
          <Text size="sm" tone="muted">
            {all.length === 1 ? '1 plugin' : `${all.length} plugins`} · {enabledCount} enabled.
            Flip one on to add what it carries, off to put it away. Plugins install
            from the repositories under Sources and run locally once installed.
          </Text>
          <div className="pluginMarket">
            {all.map((p) => (
              <PluginCard
                key={p.id}
                plugin={p}
                enabled={isEnabled(p.id)}
                crashed={failures.has(p.id)}
                // The switch is the user's setting, not the running state: a
                // crashed plugin stays checked and says so on the card, so one
                // flip OFF turns it off for good rather than retrying it first.
                // Either flip clears the crash flag, so off-and-on is the retry.
                onToggle={(on) => setEnabled(p.id, on)}
                onOpen={() => setOpenId(p.id)}
              />
            ))}
          </div>
          <Text tone="subtle" size="xs">
            Toggles apply immediately; switching a plugin may briefly restart playback.
            Work a plugin already handed to the app&rsquo;s engine - queued downloads,
            say - carries on in the background without its controls until it is
            switched back on.
          </Text>

          <div className="prefsSection">
            <Label>Available</Label>
            <PluginBrowse
              feeds={feeds}
              remoteInstalled={remoteInstalled}
              busyId={busyId}
              loading={loading}
              onInstall={(s, l) => void install(s, l)}
            />
          </div>
        </>
      ) : (
        <PluginSources
          sources={sources}
          setSources={setSources}
          feeds={feeds}
          onRefresh={refresh}
        />
      )}


      {/* The detail dialog, stacked over the settings modal - the kit's layer
          stack peels Escape one dialog at a time. */}
      <Modal
        open={open !== null}
        onClose={() => setOpenId(null)}
        size="sm"
        title={
          open && (
            <span className="pluginDetailTitle">
              <span className="pluginCardIcon" aria-hidden="true">
                {open.icon ?? <Blocks size={22} />}
              </span>
              <span>
                {open.name}
                {(open.author || open.version) && (
                  <Text as="span" size="xs" tone="subtle" className="pluginDetailByline">
                    {[open.author, open.version].filter(Boolean).join(' · ')}
                  </Text>
                )}
              </span>
            </span>
          )
        }
        footer={
          open && (
            <>
              {openRemote && (
                <UninstallButton
                  pluginId={open.id}
                  name={open.name}
                  onDone={() => setOpenId(null)}
                />
              )}
              <Button
                variant={isEnabled(open.id) ? 'ghost' : 'solid'}
                onClick={() => setEnabled(open.id, !isEnabled(open.id))}
              >
                {isEnabled(open.id) ? 'Disable' : 'Enable'}
              </Button>
            </>
          )
        }
      >
        {open && (
          <div className="pluginDetail">
            {openFailure !== undefined && (
              <Text size="sm" tone="danger">
                Crashed this session ({openFailure}). Disable and enable to try again.
              </Text>
            )}
            <div className="pluginCardTags">
              {(open.tags ?? []).map((tag) => (
                <Pill key={tag} size="sm" tone="neutral">
                  {tag}
                </Pill>
              ))}
            </div>
            <Text size="sm">{open.details ?? open.description}</Text>
            {pluginContributions(open).length > 0 && (
              <div className="pluginDetailAdds">
                <Text size="xs" tone="subtle" weight="semibold">
                  Adds to the app
                </Text>
                <ul className="pluginDetailList">
                  {pluginContributions(open).map((line) => (
                    <li key={line}>
                      <Text as="span" size="sm" tone="muted">
                        {line}
                      </Text>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </Modal>
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

  // The one-line readings the touch list shows under each row - each section's
  // current state, read from the same stores the panes edit so they can never
  // disagree. Cheap enough to compute on every open.
  const { theme, accent } = useAppearance();
  const pb = usePlayback();
  const { session } = useServerSession();
  const { connected, devices } = useConnect();
  const { all: allPlugins, isEnabled } = usePlugins();
  const { source, tracks } = useLibrary();

  const playbackBits = [
    pb.crossfade > 0 ? `Crossfade ${pb.crossfade}s` : null,
    pb.smartShuffle ? 'Smart shuffle' : null,
    pb.autoDj ? 'Auto DJ' : null,
    pb.nightMode ? 'Night mode' : null,
  ].filter(Boolean);
  const online = devices.filter((d) => d.online).length;
  const enabledPlugins = allPlugins.filter((p) => isEnabled(p.id)).length;
  // The rail's one-line reading of the vault. Subscribed rather than read once:
  // pinning happens from song menus while Settings is open behind them.
  const [offlineHeld, setOfflineHeld] = useState(() => heldCount());
  const [heldBytes, setHeldBytes] = useState<number | null>(null);
  useEffect(() => {
    const read = () => void offlineSpace().then((sp) => sp && setHeldBytes(sp.heldBytes)).catch(() => {});
    read();
    return onOfflineChange(read);
  }, []);
  useEffect(() => onOfflineChange(() => setOfflineHeld(heldCount())), []);

  const sections: SettingsSection[] = [
    {
      id: 'appearance',
      label: 'Appearance',
      icon: <Palette size={16} />,
      content: <Appearance />,
      summary: `${THEME_COPY[theme].label} · ${accentLabel(accent)}`,
      tint: 'purple',
      group: 0,
    },
    {
      id: 'general',
      label: 'General',
      icon: <Settings size={16} />,
      content: <General />,
      summary:
        source === 'server'
          ? `${tracks.length.toLocaleString()} songs from your server`
          : `${tracks.length.toLocaleString()} songs in your folder`,
      tint: 'slate',
      group: 0,
    },
    {
      id: 'playback',
      label: 'Playback',
      icon: <Play size={16} />,
      content: <PlaybackSettings />,
      summary: playbackBits.length > 0 ? playbackBits.slice(0, 2).join(' · ') : 'Standard playback',
      tint: 'pink',
      group: 0,
    },
    // Where the music comes from, when it does not come from this machine -
    // and, beside it, the devices it goes out to.
    {
      id: 'server',
      label: 'Servers',
      icon: <Server size={16} />,
      content: <ServersSettings />,
      // The host you are on, and how many boxes the account can reach. Both
      // numbers come from cheap reads, so the row is honest before any pane
      // has mounted.
      summary: (() => {
        const here = session ? session.url.replace(/^https?:\/\//, '') : 'Not connected';
        const n = knownServers().length;
        return n > 1 ? `${here} · ${n} servers` : here;
      })(),
      tint: 'blue',
      group: 1,
    },
    // The machine that listens along: the collector's ledger and switch, the
    // recent pulls, and how far the enrichment has read the library.
    {
      id: 'curator',
      label: 'Curator',
      icon: <Sparkles size={16} />,
      content: <CuratorSettings />,
      summary: session ? 'Autonomous downloads and mixes' : 'Needs a server',
      tint: 'purple',
      group: 1,
    },
    {
      id: 'storage',
      label: 'Downloads & space',
      icon: <HardDrive size={16} />,
      content: <DeviceStorageSettings />,
      // Both halves of the question in one line: how many songs are down here,
      // and what they cost. Either alone reads as half an answer.
      summary: (() => {
        const room =
          heldBytes != null && heldBytes > 0
            ? heldBytes >= 1e9
              ? `${(heldBytes / 1e9).toFixed(1)} GB`
              : `${Math.max(1, Math.round(heldBytes / 1e6))} MB`
            : null;
        if (offlineHeld > 0 && room) return `${offlineHeld} songs · ${room}`;
        if (room) return `${room} on this device`;
        return 'Nothing kept yet';
      })(),
      tint: 'green',
      group: 1,
    },
    {
      id: 'devices',
      label: 'Devices',
      icon: <MonitorSpeaker size={16} />,
      content: <DevicesSettings />,
      summary: !session
        ? 'Needs a server'
        : connected
          ? `${online} ${online === 1 ? 'device' : 'devices'} online`
          : 'Connecting…',
      tint: 'green',
      group: 1,
    },
    {
      id: 'notifications',
      label: 'Notifications',
      icon: <Bell size={16} />,
      content: <NotificationSettings />,
      summary: session ? 'What the app may interrupt you for' : 'Needs a server',
      tint: 'pink',
      group: 1,
    },
    // The importer contributes Downloads here, exactly where it has always
    // sat; any plugin's tabs land in this run of the rail.
    ...pluginSections.map((s) => ({ ...s, tint: 'orange' as const, group: 2 })),
    {
      id: 'plugins',
      label: 'Plugins',
      icon: <Blocks size={16} />,
      content: <PluginsSettings />,
      summary: `${enabledPlugins} of ${allPlugins.length} enabled`,
      tint: 'orange',
      group: 2,
    },
    {
      id: 'about',
      label: 'About',
      icon: <Info size={16} />,
      content: <AboutSettings />,
      summary: `AttackFM v${APP_VERSION}`,
      tint: 'slate',
      group: 3,
    },
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

  // On touch the rail-beside-a-pane collapses to a drill-in: a full-screen list
  // of sections that pushes into the chosen pane, a back arrow returning to it.
  const mobile = useMediaQuery(MOBILE_QUERY);
  if (mobile) {
    return <MobileSettings open={open} onClose={onClose} sections={sections} />;
  }

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

/**
 * The touch settings surface: a full-screen sheet portalled over everything.
 * It opens on the section list (the "sidebar"); tapping a row pushes into that
 * section's pane, and a back arrow at the top returns to the list. Portalled to
 * the body so it escapes the app's stacking context, exactly like Now Playing.
 */
function MobileSettings({
  open,
  onClose,
  sections,
}: {
  open: boolean;
  onClose: () => void;
  sections: SettingsSection[];
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Every fresh open lands on the list, never mid-drill on a stale section.
  useEffect(() => {
    if (!open) setActiveId(null);
  }, [open]);
  // A section pulled from under us (a plugin crash) drops us back to the list
  // rather than onto a pane that no longer exists.
  const active = sections.find((s) => s.id === activeId) ?? null;
  useEffect(() => {
    if (activeId && !sections.some((s) => s.id === activeId)) setActiveId(null);
  }, [activeId, sections]);

  if (!open) return null;

  return createPortal(
    <div
      className="settingsScreen"
      role="dialog"
      aria-label="Settings"
      data-view={active ? 'detail' : 'list'}
    >
      {active ? (
        <>
          <header className="settingsScreen__head">
            <button
              type="button"
              className="settingsScreen__icon"
              onClick={() => setActiveId(null)}
              aria-label="Back to settings"
            >
              <ChevronLeft size={22} />
            </button>
            <span className="settingsScreen__title">{active.label}</span>
            <span className="settingsScreen__headSpacer" aria-hidden="true" />
          </header>
          <div className="settingsScreen__pane">{active.content}</div>
        </>
      ) : (
        <>
          <header className="settingsScreen__head">
            <span className="settingsScreen__headSpacer" aria-hidden="true" />
            <span className="settingsScreen__title">Settings</span>
            <button
              type="button"
              className="settingsScreen__icon"
              onClick={onClose}
              aria-label="Close settings"
            >
              <X size={22} />
            </button>
          </header>
          <nav className="settingsScreen__list">
            {/* Rows cluster into cards by their group - the iOS-settings shape:
                appearance and behaviour together, the server pair, the plugin
                pair, then About on its own. */}
            {sections
              .reduce<SettingsSection[][]>((clusters, s) => {
                const last = clusters[clusters.length - 1];
                if (last && (last[0]!.group ?? 99) === (s.group ?? 99)) last.push(s);
                else clusters.push([s]);
                return clusters;
              }, [])
              .map((cluster) => (
                <div key={cluster[0]!.id} className="settingsScreen__group">
                  {cluster.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      className="settingsScreen__row"
                      onClick={() => setActiveId(s.id)}
                    >
                      {s.icon ? (
                        <span
                          className="settingsScreen__rowIcon"
                          data-tint={s.tint ?? 'slate'}
                        >
                          {s.icon}
                        </span>
                      ) : null}
                      <span className="settingsScreen__rowText">
                        <span className="settingsScreen__rowLabel">{s.label}</span>
                        {s.summary && (
                          <span className="settingsScreen__rowSummary">{s.summary}</span>
                        )}
                      </span>
                      <ChevronRight size={18} className="settingsScreen__rowChevron" />
                    </button>
                  ))}
                </div>
              ))}
          </nav>
        </>
      )}
    </div>,
    document.body,
  );
}
