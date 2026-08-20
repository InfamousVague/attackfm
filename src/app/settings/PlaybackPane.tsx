import { Field, Label, SegmentedControl, Select, Slider, Switch, Text } from '@glacier/react';
import { useEffect, useState } from 'react';
import { fireNativeHaptic, setHapticsPref, useHapticsPref } from '../core/haptics.ts';
import { usePlayback, type SleepTimer } from '../player/playback.tsx';
import {
  motionGesturesEnabled,
  nowPlayingVideoEnabled,
  setMotionGestures,
  setNowPlayingVideo,
} from './behaviourPrefs.ts';
import { askMotionAccess, motionAvailable } from '../player/deviceMotion.ts';
import {
  loudnessCoverage,
  setLoudnessMode,
  useLoudnessMode,
  type LoudnessMode,
} from '../player/loudness.ts';

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
  const [motion, setMotion] = useState(motionGesturesEnabled);
  const pb = usePlayback();
  const [video, setVideo] = useState(nowPlayingVideoEnabled);
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

  const levelling = useLoudnessMode();
  const measured = loudnessCoverage();

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <Field
          label="Volume levelling"
          hint={
            levelling === 'off'
              ? 'Songs play at whatever level they were mastered at.'
              : levelling === 'album'
                ? 'Records play at a steady level, and the quiet track on an album stays quiet.'
                : 'Every song plays at the same level — best for shuffling.'
          }
        >
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
          {levelling !== 'off' && (
            <Text tone="muted" size="sm">
              {measured === 0
                ? 'Your server is still measuring. Songs it has not reached yet play unlevelled.'
                : `${measured.toLocaleString()} songs measured. A song is never boosted past the point where it would distort.`}
            </Text>
          )}
        </Field>
      </div>
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
        {/* Shuffle's MANNERS, which is all this has ever been - the field is
            called smartShuffle for historical reasons and is not the parked
            "Smart shuffle" mode, which was the shuffle button's third state.
            This one stays: it costs nothing, needs no server, and turning it
            off is a worse shuffle rather than a missing feature. */}
        <Switch
          label="Shuffle manners"
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
        {motionAvailable() && (
          <>
            <Switch
              label="Shake and flick"
              checked={motion}
              onCheckedChange={(on) => {
                // iOS only grants motion access from inside a real gesture, and
                // this switch IS one - asking anywhere else is refused with no
                // prompt shown, which reads as the switch not working.
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
            <Text tone="muted" size="sm">
              On the Now Playing screen: shake to change shuffle, flick left or right to move
              between songs. Off by default because a gesture that misreads costs you the song you
              were listening to — walking, running and a pocket are all ignored, but a phone that
              lives in a bag may still find a way.
            </Text>
          </>
        )}
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
      {/* "Save listening history" moved to Privacy, with the other switches
          about what leaves the device. Its copy here said "Off, nothing is
          written anywhere", which was not true: the player was also sending
          your position to registry.attack.fm on a twenty-second timer, gated
          by nothing. Both switches sit together now, where that claim can be
          read against the row that contradicted it. */}
      <div className="prefsSection" data-setting="now-playing-video">
        <Label>Now Playing</Label>
        <Switch
          label="Video clips on Now Playing"
          checked={video}
          onCheckedChange={(on: boolean) => {
            setNowPlayingVideo(on);
            setVideo(on);
          }}
        />
        <Text tone="muted" size="sm">
          Plays the song&rsquo;s short looping clip behind the full player. Each new song
          pulls down a few megabytes of video, and your server asks Spotify for it by
          song title. Off leaves the blurred cover.
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
