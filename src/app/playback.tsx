import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

const STORAGE_KEY = 'attackfm-playback';

/** How a pause lands: the platter braking, a quick fade, or a plain cut. */
export type PauseStyle = 'turntable' | 'fade' | 'instant';

/**
 * How the hero spells the song's words - see WORD_WAYS in NowPlayingBackdrop
 * for what each one looks like. `off` draws nothing at all; `random` draws a
 * fresh way on every skip, which is what the hero did before this was a
 * setting; the rest pin it.
 */
export type LyricWay = 'off' | 'random' | 'scatter' | 'typewriter' | 'poster' | 'stack';

/**
 * The sleep timer's target: a clock time (kept with the preset that chose it,
 * so the settings can keep showing which button is lit), the end of the
 * current track, or off.
 */
export type SleepTimer = { at: number; minutes: number } | 'end-of-track' | null;

export interface PlaybackSettings {
  /** Seconds the end of one song blends into the start of the next; 0 is off. */
  crossfade: number;
  /** Shuffle avoids repeating an artist back-to-back when it has a choice. */
  smartShuffle: boolean;
  /** When the queue runs out, keep going with similar songs from the library. */
  autoDj: boolean;
  /** Evens out loud and quiet - a gentle squeeze for late-night listening. */
  nightMode: boolean;
  /** Folds the channels together and plays the same signal to both ears. */
  mono: boolean;
  /**
   * iPhone only: route playback through the audio graph so the equalizer
   * (and night mode, mono, the boost range) work there too. Off by default
   * because WebKit can silence the graph when the screen locks - the
   * background playback that direct playback guarantees is the safer trade
   * until the native audio engine lands. Applies from the next launch: an
   * element the graph has captured stays captured.
   */
  iosEq: boolean;
  /**
   * Whether the fader may push past 100% into the boost range. Off caps it at
   * unity - a hearing-safety and speaker-protection choice, so the max the
   * hardware volume set is the max anything plays at.
   */
  volumeBoost: boolean;
  /**
   * Whether qualifying listens are reported to the connected server. On feeds
   * the Home page's history shelves and mixes; off keeps listening entirely
   * unrecorded, everywhere.
   */
  saveHistory: boolean;
  pauseStyle: PauseStyle;
  /** How the hero spells the song's words behind the header. */
  lyricWay: LyricWay;
}

interface PlaybackContextValue extends PlaybackSettings {
  update: (next: Partial<PlaybackSettings>) => void;
  /**
   * The sleep timer. Runtime state, not a setting: a timer that survived a
   * relaunch would stop the music of a session it was never set for, so it is
   * deliberately not persisted with the rest.
   */
  sleep: SleepTimer;
  setSleep: (next: SleepTimer) => void;
}

const DEFAULTS: PlaybackSettings = {
  crossfade: 0,
  smartShuffle: true,
  autoDj: false,
  nightMode: false,
  mono: false,
  iosEq: false,
  volumeBoost: true,
  saveHistory: true,
  pauseStyle: 'turntable',
  lyricWay: 'stack',
};

const PAUSE_STYLES: readonly PauseStyle[] = ['turntable', 'fade', 'instant'];
export const LYRIC_WAYS: readonly LyricWay[] = [
  'off',
  'random',
  'scatter',
  'typewriter',
  'poster',
  'stack',
];

const PlaybackContext = createContext<PlaybackContextValue | null>(null);

/** The stored settings, each field checked on its own so one bad value cannot
 * take the rest down with it. */
function readStored(): PlaybackSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Record<keyof PlaybackSettings, unknown>>;
    return {
      crossfade:
        typeof parsed.crossfade === 'number' && Number.isFinite(parsed.crossfade)
          ? Math.min(12, Math.max(0, Math.round(parsed.crossfade)))
          : DEFAULTS.crossfade,
      smartShuffle: typeof parsed.smartShuffle === 'boolean' ? parsed.smartShuffle : DEFAULTS.smartShuffle,
      autoDj: typeof parsed.autoDj === 'boolean' ? parsed.autoDj : DEFAULTS.autoDj,
      nightMode: typeof parsed.nightMode === 'boolean' ? parsed.nightMode : DEFAULTS.nightMode,
      mono: typeof parsed.mono === 'boolean' ? parsed.mono : DEFAULTS.mono,
      iosEq: typeof parsed.iosEq === 'boolean' ? parsed.iosEq : DEFAULTS.iosEq,
      volumeBoost:
        typeof parsed.volumeBoost === 'boolean' ? parsed.volumeBoost : DEFAULTS.volumeBoost,
      saveHistory:
        typeof parsed.saveHistory === 'boolean' ? parsed.saveHistory : DEFAULTS.saveHistory,
      pauseStyle: PAUSE_STYLES.includes(parsed.pauseStyle as PauseStyle)
        ? (parsed.pauseStyle as PauseStyle)
        : DEFAULTS.pauseStyle,
      lyricWay: LYRIC_WAYS.includes(parsed.lyricWay as LyricWay)
        ? (parsed.lyricWay as LyricWay)
        : DEFAULTS.lyricWay,
    };
  } catch {
    return DEFAULTS;
  }
}

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<PlaybackSettings>(readStored);
  const [sleep, setSleep] = useState<SleepTimer>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // A storage that will not take the setting is not worth failing over.
    }
  }, [settings]);

  const value = useMemo<PlaybackContextValue>(
    () => ({
      ...settings,
      update: (next) => setSettings((prev) => ({ ...prev, ...next })),
      sleep,
      setSleep,
    }),
    [settings, sleep],
  );

  return <PlaybackContext.Provider value={value}>{children}</PlaybackContext.Provider>;
}

export function usePlayback(): PlaybackContextValue {
  const value = useContext(PlaybackContext);
  if (!value) throw new Error('usePlayback must be used within a PlaybackProvider');
  return value;
}
