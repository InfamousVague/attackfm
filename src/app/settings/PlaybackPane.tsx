import { Field, Label, SegmentedControl, Select, Slider, Switch, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import { fireNativeHaptic, setHapticsPref, useHapticsPref } from '../core/haptics.ts';
import { usePlayback, type SleepTimer } from '../player/playback.tsx';

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
export function PlaybackSettings() {
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
