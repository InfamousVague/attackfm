import { useState } from 'react';
import { Label, Switch, Text } from '@glacier/react';
import { usePlayback } from '../player/playback.tsx';
import { setSharing, useSharing } from '../profile/listeningShare.tsx';
import { onlineMetadataEnabled, setOnlineMetadata } from './netPrefs.ts';
import { sharePositionEnabled, setSharePosition } from './behaviourPrefs.ts';

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
 * how you find the rung you are not comfortable with.
 */
export function Privacy() {
  const pb = usePlayback();
  const sharingWeek = useSharing();
  const [online, setOnline] = useState(onlineMetadataEnabled);
  const [position, setPosition] = useState(sharePositionEnabled);

  return (
    <div className="prefsBody">
      <div className="prefsSection" data-setting="online-metadata">
        <Label>Outside services</Label>
        <Switch
          label="Online metadata lookups"
          checked={online}
          onCheckedChange={(on: boolean) => {
            setOnlineMetadata(on);
            setOnline(on);
          }}
        />
        <Text tone="muted" size="sm">
          Fetches lyrics from LRCLIB and album art from Apple, keyed by track titles. Off keeps
          the app entirely between your devices and your own server.
        </Text>
      </div>

      <div className="prefsSection" data-setting="listening-history">
        <Label>Your server</Label>
        <Switch
          label="Save listening history"
          checked={pb.saveHistory}
          onCheckedChange={(on: boolean) => pb.update({ saveHistory: on })}
        />
        <Text tone="muted" size="sm">
          Reports finished listens to your server — it is what feeds the Home page&rsquo;s
          recently-played shelves and your mixes. It stays on your server.
        </Text>
      </div>

      <div className="prefsSection" data-setting="share-position">
        <Label>Your account</Label>
        <Switch
          label="Keep my place across devices"
          checked={position}
          onCheckedChange={(on: boolean) => {
            setSharePosition(on);
            setPosition(on);
          }}
        />
        <Text tone="muted" size="sm">
          Sends what you are playing — song, artist and how far in — to your AttackFM account
          every twenty seconds, so another device could pick it up. Off by default, because
          nothing in the app offers to resume from it yet.
        </Text>
      </div>

      <div className="prefsSection" data-setting="share-week">
        <Label>Other people</Label>
        <Switch
          label="Share my week with friends"
          checked={sharingWeek}
          onCheckedChange={(on: boolean) => setSharing(on)}
        />
        <Text tone="muted" size="sm">
          Minutes listened, your top artist and your streak, sent to your AttackFM account every
          six hours where friends you have accepted can see them. No track list, no times. The
          same switch as the one on Friends.
        </Text>
      </div>
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
