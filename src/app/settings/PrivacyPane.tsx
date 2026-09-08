import { useState } from 'react';
import { Switch } from '@glacier/react';
import { usePlayback } from '../player/playback.tsx';
import { setSharing, useSharing } from '../profile/sharingPref.ts';
import { onlineMetadataEnabled, setOnlineMetadata } from './netPrefs.ts';
import { sharePositionEnabled, setSharePosition } from './behaviourPrefs.ts';
import { PaneSection, SettingRow } from './kit/settingsKit.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

/**
 * What leaves this device, and who gets it.
 *
 * These four switches existed in four places, or in no place. "Online metadata"
 * sat in General under a literal <Label>Privacy</Label> - a label asking to be a
 * pane. "Save listening history" sat in Playback. "Share my week" was only ever
 * on the Friends page, which many people never open, and Settings is where
 * somebody goes looking for a privacy switch. And sending your position to your
 * AttackFM account had no switch at all.
 *
 * They are ordered by how far the data travels: nothing, then your own server,
 * then your account, then other people. That ladder is the point of gathering
 * them - each row is a longer throw than the one above it, and reading down is
 * how you find the rung you are not comfortable with. This pane is also the
 * settings kit's template: one section per rung, one row per switch, the
 * caption bound to its control.
 */
export function Privacy() {
  const pb = usePlayback();
  const sharingWeek = useSharing();
  const [online, setOnline] = useState(onlineMetadataEnabled);
  const [position, setPosition] = useState(sharePositionEnabled);
  const t = useT();

  return (
    <div className="prefsBody">
      <PaneSection title={t('privacy.outsideServices')}>
        <SettingRow
          id="online-metadata"
          label={t('privacy.onlineMetadata')}
          hint={t('privacy.onlineMetadataHint')}
          control={
            <Switch
              aria-label={t('privacy.onlineMetadata')}
              checked={online}
              onCheckedChange={(on: boolean) => {
                setOnlineMetadata(on);
                setOnline(on);
              }}
            />
          }
        />
      </PaneSection>

      <PaneSection title={t('privacy.yourServer')}>
        <SettingRow
          id="listening-history"
          label={t('privacy.saveHistory')}
          hint={t('privacy.saveHistoryHint')}
          control={
            <Switch
              aria-label={t('privacy.saveHistory')}
              checked={pb.saveHistory}
              onCheckedChange={(on: boolean) => pb.update({ saveHistory: on })}
            />
          }
        />
      </PaneSection>

      <PaneSection title={t('privacy.yourAccount')}>
        <SettingRow
          id="share-position"
          label={t('privacy.keepPlace')}
          hint={t('privacy.keepPlaceHint')}
          control={
            <Switch
              aria-label={t('privacy.keepPlace')}
              checked={position}
              onCheckedChange={(on: boolean) => {
                setSharePosition(on);
                setPosition(on);
              }}
            />
          }
        />
      </PaneSection>

      <PaneSection title={t('privacy.otherPeople')}>
        <SettingRow
          id="share-week"
          label={t('privacy.shareWithFriends')}
          hint={t('privacy.shareWithFriendsHint')}
          control={
            <Switch
              aria-label={t('privacy.shareWithFriends')}
              checked={sharingWeek}
              onCheckedChange={(on: boolean) => setSharing(on)}
            />
          }
        />
      </PaneSection>
    </div>
  );
}
