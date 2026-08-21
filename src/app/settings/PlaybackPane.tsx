import { SegmentedControl, Switch, Text } from '@glacier/react';
import { StemProgress, usePrefetchStatus } from '../servers/BackgroundWork.tsx';
import { useEffect, useState } from 'react';
import { usePlayback, type SleepTimer } from '../player/playback.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  loudnessCoverage,
  setLoudnessMode,
  useLoudnessMode,
  type LoudnessMode,
} from '../player/loudness.ts';
import { PaneSection, SettingRow, SettingSliderRow } from './kit/settingsKit.tsx';

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
  if (sleep === 'end-of-track') return <>Playback stops when the current track ends.</>;
  const remaining = Math.max(0, sleep.at - now);
  const minutes = Math.floor(remaining / 60_000);
  const seconds = Math.floor((remaining % 60_000) / 1000);
  return (
    <>
      Playback stops in {minutes}:{String(seconds).padStart(2, '0')}.
    </>
  );
}

/**
 * The playback behaviours: how songs hand over to each other, what they cost
 * to stream, what shuffle avoids, how the sound is shaped, and when the music
 * should put itself to bed. All of it lives in the playback context the
 * player reads, so every control here takes effect mid-song.
 *
 * What LEFT this pane is as deliberate as what is in it: the lyric header,
 * the Now Playing clips, haptics and the motion gestures are all about how
 * the app looks and feels rather than how music plays, and live under
 * Appearance now. Streaming quality moved IN from the server dashboard,
 * because "how much data does listening cost me" is a listener's playback
 * question, not a fact about the box.
 */
export function PlaybackSettings() {
  const pb = usePlayback();
  const { session, settings, updateSettings } = useServerSession();

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

  const levelling = useLoudnessMode();
  const measured = loudnessCoverage();

  return (
    <div className="prefsBody">
      <PaneSection
        title="Loudness"
        footer={
          levelling !== 'off'
            ? measured === 0
              ? 'Your server is still measuring. Songs it has not reached yet play unlevelled.'
              : `${measured.toLocaleString()} songs measured. A song is never boosted past the point where it would distort.`
            : undefined
        }
      >
        <SettingRow
          label="Volume levelling"
          hint={
            levelling === 'off'
              ? 'Songs play at whatever level they were mastered at.'
              : levelling === 'album'
                ? 'Records play at a steady level, and the quiet track on an album stays quiet.'
                : 'Every song plays at the same level — best for shuffling.'
          }
          layout="stacked"
          control={
            <SegmentedControl
              aria-label="Volume levelling"
              fullWidth
              value={levelling}
              options={[
                { value: 'off', label: 'Off' },
                { value: 'track', label: 'Per song' },
                { value: 'album', label: 'Per album' },
              ]}
              onValueChange={(v) => setLoudnessMode(v as LoudnessMode)}
            />
          }
        />
      </PaneSection>

      <PaneSection title="Between songs">
        <SettingSliderRow
          id="crossfade"
          label="Crossfade"
          hint="Blends the end of one song into the start of the next. Automatic changes only - skips stay immediate."
          min={0}
          max={12}
          step={1}
          value={pb.crossfade}
          valueLabel={pb.crossfade === 0 ? 'Off' : `${pb.crossfade}s`}
          onChange={(next) => pb.update({ crossfade: next })}
        />
        <SettingRow
          label="Pause"
          hint="What pressing pause sounds like."
          layout="stacked"
          control={
            <SegmentedControl
              aria-label="Pause style"
              fullWidth
              value={pb.pauseStyle}
              onValueChange={(next) => pb.update({ pauseStyle: next as typeof pb.pauseStyle })}
              options={[
                { value: 'turntable', label: 'Turntable' },
                { value: 'fade', label: 'Fade' },
                { value: 'instant', label: 'Cut' },
              ]}
            />
          }
        />
      </PaneSection>

      {/* Moved in from the server dashboard: what listening costs is a
          listener's question. The STATE stays server-side through the same
          session settings - this row is a view over it, never a second
          store - so the dashboard losing the control changed nothing about
          where the choice lives. */}
      <PaneSection title="Streaming">
        <SettingRow
          id="streaming-quality"
          label="Streaming quality"
          hint={
            !session
              ? undefined
              : settings.quality === 'lossless'
                ? 'Sends the original file, byte for byte. No re-encoding, and no work for the server.'
                : 'Re-encodes on the fly to save data. Costs the server a CPU core per listener.'
          }
          disabledReason={session ? undefined : 'Needs a server'}
          layout="stacked"
          control={
            <SegmentedControl
              aria-label="Streaming quality"
              fullWidth
              value={settings.quality}
              onValueChange={(next) => updateSettings({ quality: next as 'lossless' | 'transcode' })}
              options={[
                { value: 'lossless', label: 'Lossless' },
                { value: 'transcode', label: 'Data saver' },
              ]}
            />
          }
        />
        {session && settings.quality === 'transcode' && (
          <SettingSliderRow
            label="Bitrate"
            min={96}
            max={320}
            step={32}
            value={settings.bitrate}
            valueLabel={`${settings.bitrate}k`}
            onChange={(next) => updateSettings({ bitrate: next })}
          />
        )}
      </PaneSection>

      <PaneSection title="Queue">
        {/* Shuffle's MANNERS, which is all this has ever been - the field is
            called smartShuffle for historical reasons and is not the parked
            "Smart shuffle" mode, which was the shuffle button's third state.
            This one stays: it costs nothing, needs no server, and turning it
            off is a worse shuffle rather than a missing feature. */}
        <SettingRow
          label="Shuffle manners"
          hint="Shuffle avoids playing the same artist twice in a row, and steers around songs it just played."
          control={
            <Switch
              aria-label="Shuffle manners"
              checked={pb.smartShuffle}
              onCheckedChange={(on) => pb.update({ smartShuffle: on })}
            />
          }
        />
        <SettingRow
          label="Auto DJ"
          hint="When the queue runs out, keeps playing similar songs from the library instead of stopping."
          control={
            <Switch
              aria-label="Auto DJ"
              checked={pb.autoDj}
              onCheckedChange={(on) => pb.update({ autoDj: on })}
            />
          }
        />
      </PaneSection>

      <PaneSection title="Sound" footer={<StemsReadout />}>
        <SettingRow
          label="Night mode"
          hint="Evens out loud and quiet passages, for listening at low volume without riding the fader."
          control={
            <Switch
              aria-label="Night mode"
              checked={pb.nightMode}
              onCheckedChange={(on) => pb.update({ nightMode: on })}
            />
          }
        />
        <SettingRow
          label="Mono"
          hint="Plays the same signal to both ears - for single-earbud listening, or hearing comfort."
          control={
            <Switch aria-label="Mono" checked={pb.mono} onCheckedChange={(on) => pb.update({ mono: on })} />
          }
        />
        <SettingRow
          label="Volume boost range"
          hint="Lets the fader push past 100% for quiet recordings. Off caps it at unity - kinder to ears and speakers."
          control={
            <Switch
              aria-label="Volume boost range"
              checked={pb.volumeBoost}
              onCheckedChange={(on) => pb.update({ volumeBoost: on })}
            />
          }
        />
      </PaneSection>

      <PaneSection
        title="Sleep"
        tone="session"
        footer={<SleepCountdown sleep={pb.sleep} />}
      >
        <SettingRow
          id="sleep-timer"
          label="Sleep timer"
          hint="Fades out and pauses when the time is up. Cleared on relaunch."
          layout="stacked"
          control={
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
          }
        />
      </PaneSection>
    </div>
  );
}

/**
 * How far the server has got through pulling your library apart.
 *
 * Here as well as under Servers, and that is the point rather than an oversight.
 * The row under Servers is a CONTROL - it spends the operator's GPU and disk, so
 * it is admin-only and lives with the other things that cost the machine
 * something. But "how much of my music can I pull apart yet" is a listener's
 * question about their own library, and nobody looking for that opens Servers.
 * The status endpoint asks only for a signed-in caller, so this needs no
 * privileges of its own. It rides as the Sound group's footer now: a status
 * readout attached to the group it describes, not a row pretending to be a
 * setting.
 *
 * Renders nothing beyond one sentence when the server has no separation tools -
 * an empty progress bar answering a question nobody asked is worse than the
 * absence.
 */
function StemsReadout() {
  const state = usePrefetchStatus();
  if (!state || !state.available) {
    return (
      <>
        This server does not take songs apart, so the Stems tab and the Pads work on whatever you
        play as you play it.
      </>
    );
  }
  return (
    <>
      <Text tone="muted" size="sm">
        Songs you have liked or put in a playlist are pulled apart on the server ahead of time, so
        the Stems tab and the Pads open straight away instead of after a wait.
      </Text>
      <StemProgress state={state} />
    </>
  );
}
