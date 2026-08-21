import { useState } from 'react';
import { Switch } from '@glacier/react';
import { usePlayback } from '../player/playback.tsx';
import { setSharing, useSharing } from '../profile/listeningShare.tsx';
import { onlineMetadataEnabled, setOnlineMetadata } from './netPrefs.ts';
import { sharePositionEnabled, setSharePosition } from './behaviourPrefs.ts';
import { PaneSection, SettingRow } from './kit/settingsKit.tsx';

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

  return (
    <div className="prefsBody">
      <PaneSection title="Outside services">
        <SettingRow
          id="online-metadata"
          label="Online metadata lookups"
          hint="Fetches lyrics from LRCLIB and album art from Apple, keyed by track titles. Off keeps the app entirely between your devices and your own server."
          control={
            <Switch
              aria-label="Online metadata lookups"
              checked={online}
              onCheckedChange={(on: boolean) => {
                setOnlineMetadata(on);
                setOnline(on);
              }}
            />
          }
        />
      </PaneSection>

      <PaneSection title="Your server">
        <SettingRow
          id="listening-history"
          label="Save listening history"
          hint="Reports finished listens to your server — it is what feeds the Home page's recently-played shelves and your mixes. It stays on your server."
          control={
            <Switch
              aria-label="Save listening history"
              checked={pb.saveHistory}
              onCheckedChange={(on: boolean) => pb.update({ saveHistory: on })}
            />
          }
        />
      </PaneSection>

      <PaneSection title="Your account">
        <SettingRow
          id="share-position"
          label="Keep my place across devices"
          hint="Sends what you are playing — song, artist and how far in — to your AttackFM account every twenty seconds. It is what lets another device pick up mid-song, and what the audiobook shelf reads to continue where you left off."
          control={
            <Switch
              aria-label="Keep my place across devices"
              checked={position}
              onCheckedChange={(on: boolean) => {
                setSharePosition(on);
                setPosition(on);
              }}
            />
          }
        />
      </PaneSection>

      <PaneSection title="Other people">
        <SettingRow
          id="share-week"
          label="Share my week with friends"
          hint="Minutes listened, your top artist and your streak, sent to your AttackFM account every six hours where friends you have accepted can see them. No track list, no times. The same switch as the one on Friends."
          control={
            <Switch
              aria-label="Share my week with friends"
              checked={sharingWeek}
              onCheckedChange={(on: boolean) => setSharing(on)}
            />
          }
        />
      </PaneSection>
    </div>
  );
}

/** The row's second line on the touch list: how much is switched off. */
export function privacySummary(
  online: boolean,
  history: boolean,
  position: boolean,
  week: boolean,
): string {
  const off = [online, history, position, week].filter((x) => !x).length;
  if (off === 0) return 'Everything shared';
  if (off === 4) return 'Nothing leaves this device';
  return `${off} of 4 off`;
}
