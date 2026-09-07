import { SegmentedControl, Switch, Text } from '@glacier/react';
import { StemProgress, usePrefetchStatus } from '../servers/BackgroundWork.tsx';
import { useEffect, useState } from 'react';
import { sleepsAtAnEnd, usePlayback, type SleepTimer } from '../player/playback.tsx';
import type { DriveBoost } from '../player/driveBoost.ts';
import { useServerSession } from '../servers/serverSession.tsx';
import {
  loudnessCoverage,
  setLoudnessMode,
  useLoudnessMode,
  type LoudnessMode,
} from '../player/loudness.ts';
import { PaneSection, SettingRow, SettingSliderRow } from './kit/settingsKit.tsx';
import { Trans, useT } from '../i18n/LocaleShell.tsx';
import { formatClock, formatNumber } from '../ux/format.ts';

/** The sleep timer's countdown, ticking once a second while one is armed. */
function SleepCountdown({ sleep }: { sleep: SleepTimer }) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const running = sleep !== null && !sleepsAtAnEnd(sleep);
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
  if (sleep === 'end-of-track') return <>{t('settings.sleepStopsAtTrackEnd')}</>;
  if (sleep === 'end-of-chapter') return <>{t('settings.sleepStopsAtChapterEnd')}</>;
  // One sentence, one entry: the clock used to sit between two text fragments,
  // which is three pieces a translator cannot reorder. formatClock does the
  // mm:ss padding this was doing by hand, and keeps Latin digits for the same
  // reason the player's clocks do.
  const remaining = Math.max(0, sleep.at - now);
  return <Trans i18nKey="settings.sleepStopsIn" values={{ time: formatClock(remaining / 1000) }} />;
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
  const t = useT();
  const pb = usePlayback();
  const { session, settings, updateSettings } = useServerSession();

  /*
   * What "the end of this" means depends on what is playing.
   *
   * A twelve-hour reading is usually ONE file, so "track end" on a book is a
   * sleep timer set for tomorrow morning. For a book the same button waits for
   * the next chapter break instead, which is what anyone reaching for it in
   * bed meant - and the label says so, rather than promising one thing and
   * doing another.
   */
  const endMode: SleepTimer = pb.bookPlaying ? 'end-of-chapter' : 'end-of-track';
  const sleepValue =
    pb.sleep === null ? 'off' : sleepsAtAnEnd(pb.sleep) ? 'end' : String(pb.sleep.minutes);
  const setSleepChoice = (choice: string) => {
    if (choice === 'off') pb.setSleep(null);
    else if (choice === 'end') pb.setSleep(endMode);
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
        title={t('settings.loudness')}
        footer={
          levelling !== 'off'
            ? measured === 0
              ? t('settings.loudnessMeasuring')
              : // `count` picks the plural form, `n` is the number as this
                // locale writes it - i18next interpolates a raw number, and a
                // library-sized count wants its thousands grouped.
                t('settings.loudnessMeasured', { count: measured, n: formatNumber(measured) })
            : undefined
        }
      >
        <SettingRow
          label={t('settings.volumeLevelling')}
          hint={
            levelling === 'off'
              ? t('settings.levellingOffHint')
              : levelling === 'album'
                ? t('settings.levellingAlbumHint')
                : t('settings.levellingTrackHint')
          }
          layout="stacked"
          control={
            <SegmentedControl
              aria-label={t('settings.volumeLevelling')}
              fullWidth
              value={levelling}
              options={[
                { value: 'off', label: t('common.off') },
                { value: 'track', label: t('settings.levellingPerSong') },
                { value: 'album', label: t('settings.levellingPerAlbum') },
              ]}
              onValueChange={(v) => setLoudnessMode(v as LoudnessMode)}
            />
          }
        />
      </PaneSection>

      <PaneSection title={t('settings.betweenSongs')}>
        <SettingSliderRow
          id="crossfade"
          label={t('settings.crossfade')}
          hint={t('settings.crossfadeHint')}
          min={0}
          max={12}
          step={1}
          value={pb.crossfade}
          valueLabel={
            pb.crossfade === 0 ? t('common.off') : t('settings.secondsShort', { n: pb.crossfade })
          }
          onChange={(next) => pb.update({ crossfade: next })}
        />
        <SettingRow
          label={t('settings.pause')}
          hint={t('settings.pauseHint')}
          layout="stacked"
          control={
            <SegmentedControl
              aria-label={t('settings.pauseStyle')}
              fullWidth
              value={pb.pauseStyle}
              onValueChange={(next) => pb.update({ pauseStyle: next as typeof pb.pauseStyle })}
              options={[
                { value: 'turntable', label: t('settings.pauseTurntable') },
                { value: 'fade', label: t('settings.pauseFade') },
                { value: 'instant', label: t('settings.pauseCut') },
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
      <PaneSection title={t('settings.streaming')}>
        <SettingRow
          id="streaming-quality"
          label={t('settings.streamingQuality')}
          hint={
            !session
              ? undefined
              : settings.quality === 'lossless'
                ? t('settings.streamingLosslessHint')
                : t('settings.streamingTranscodeHint')
          }
          disabledReason={session ? undefined : t('servers.needsAServer')}
          layout="stacked"
          control={
            <SegmentedControl
              aria-label={t('settings.streamingQuality')}
              fullWidth
              disabled={!session}
              value={settings.quality}
              onValueChange={(next) => updateSettings({ quality: next as 'lossless' | 'transcode' })}
              options={[
                { value: 'lossless', label: t('settings.streamingLossless') },
                { value: 'transcode', label: t('settings.streamingDataSaver') },
              ]}
            />
          }
        />
        {session && settings.quality === 'transcode' && (
          <SettingSliderRow
            label={t('settings.bitrate')}
            min={96}
            max={320}
            step={32}
            value={settings.bitrate}
            valueLabel={t('settings.bitrateShort', { n: settings.bitrate })}
            onChange={(next) => updateSettings({ bitrate: next })}
          />
        )}
      </PaneSection>

      <PaneSection title={t('settings.queue')}>
        {/* Shuffle's MANNERS, which is all this has ever been - the field is
            called smartShuffle for historical reasons and is not the parked
            "Smart shuffle" mode, which was the shuffle button's third state.
            This one stays: it costs nothing, needs no server, and turning it
            off is a worse shuffle rather than a missing feature. */}
        <SettingRow
          label={t('settings.shuffleManners')}
          hint={t('settings.shuffleMannersHint')}
          control={
            <Switch
              aria-label={t('settings.shuffleManners')}
              checked={pb.smartShuffle}
              onCheckedChange={(on) => pb.update({ smartShuffle: on })}
            />
          }
        />
        <SettingRow
          label={t('settings.autoDj')}
          hint={t('settings.autoDjHint')}
          control={
            <Switch
              aria-label={t('settings.autoDj')}
              checked={pb.autoDj}
              onCheckedChange={(on) => pb.update({ autoDj: on })}
            />
          }
        />
      </PaneSection>

      <PaneSection title={t('settings.sound')} footer={<StemsReadout />}>
        <SettingRow
          label={t('settings.nightMode')}
          hint={t('settings.nightModeHint')}
          control={
            <Switch
              aria-label={t('settings.nightMode')}
              checked={pb.nightMode}
              onCheckedChange={(on) => pb.update({ nightMode: on })}
            />
          }
        />
        <SettingRow
          label={t('settings.mono')}
          hint={t('settings.monoHint')}
          control={
            <Switch
              aria-label={t('settings.mono')}
              checked={pb.mono}
              onCheckedChange={(on) => pb.update({ mono: on })}
            />
          }
        />
        <SettingRow
          label={t('settings.volumeBoost')}
          hint={t('settings.volumeBoostHint')}
          control={
            <Switch
              aria-label={t('settings.volumeBoost')}
              checked={pb.volumeBoost}
              onCheckedChange={(on) => pb.update({ volumeBoost: on })}
            />
          }
        />
        {/* Speed Compensated Volume, the phone way. Stacked like the pane's
            other segmented rows - a four-option control beside a label column
            crushed the hint into a one-word-wide tower - and the hint answers
            for the CURRENT choice, the way Volume levelling's does, instead of
            reciting the whole manual at once. */}
        <SettingRow
          label={t('settings.driveBoost')}
          layout="stacked"
          hint={
            pb.driveBoost === 'off'
              ? t('settings.driveBoostOffHint')
              : pb.driveBoost === 'gentle'
                ? t('settings.driveBoostGentleHint')
                : pb.driveBoost === 'standard'
                  ? t('settings.driveBoostStandardHint')
                  : t('settings.driveBoostStrongHint')
          }
          control={
            <SegmentedControl
              aria-label={t('settings.driveBoost')}
              fullWidth
              value={pb.driveBoost}
              options={[
                { value: 'off', label: t('common.off') },
                { value: 'gentle', label: t('settings.driveBoostGentle') },
                { value: 'standard', label: t('settings.driveBoostStandard') },
                { value: 'strong', label: t('settings.driveBoostStrong') },
              ]}
              onValueChange={(v) => pb.update({ driveBoost: v as DriveBoost })}
            />
          }
        />
      </PaneSection>

      <PaneSection
        title={t('settings.sleep')}
        tone="session"
        footer={<SleepCountdown sleep={pb.sleep} />}
      >
        <SettingRow
          id="sleep-timer"
          label={t('settings.sleepTimer')}
          hint={
            pb.bookPlaying
              ? t('settings.sleepTimerHintBook')
              : t('settings.sleepTimerHint')
          }
          layout="stacked"
          control={
            <SegmentedControl
              aria-label={t('settings.sleepTimer')}
              fullWidth
              value={sleepValue}
              onValueChange={setSleepChoice}
              options={[
                { value: 'off', label: t('common.off') },
                { value: '15', label: t('settings.minutesShort', { n: 15 }) },
                { value: '30', label: t('settings.minutesShort', { n: 30 }) },
                { value: '45', label: t('settings.minutesShort', { n: 45 }) },
                { value: '60', label: t('settings.hoursShort', { n: 1 }) },
                {
                  value: 'end',
                  label: pb.bookPlaying
                    ? t('settings.sleepAtChapterEnd')
                    : t('settings.sleepAtTrackEnd'),
                },
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
  const t = useT();
  const state = usePrefetchStatus();
  if (!state || !state.available) {
    return <>{t('settings.stemsUnavailable')}</>;
  }
  return (
    <>
      <Text tone="muted" size="sm">
        {t('settings.stemsPrefetched')}
      </Text>
      <StemProgress state={state} />
    </>
  );
}
