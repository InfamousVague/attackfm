import { Button, Field, Input, StatusDot, Text } from '@glacier/react';
import { Laptop, MonitorSpeaker, Save, Smartphone } from '@glacier/icons';
import { useState } from 'react';
import { deviceKind, deviceName } from '../player/connect.ts';
import { DeviceList } from '../player/DevicePicker.tsx';
import { useConnect } from '../player/playbackSync.tsx';
import { useServerSession } from '../servers/serverSession.tsx';

/**
 * The Devices pane: this device's Connect identity, and every other device on
 * the account.
 *
 * The rename is the reason the pane exists - the picker names devices
 * "iPhone" or "This browser", which stops being enough the moment there are
 * two of either. The name announces to the hub immediately on save, so every
 * other device's picker updates without a reconnect. The list below is the
 * same DeviceList the player's picker shows, because they must never
 * disagree about what is connected.
 */
export function DevicesSettings() {
  const { session } = useServerSession();
  const { connected, devices, renameDevice } = useConnect();
  const [name, setName] = useState(() => deviceName());
  const [savedFlash, setSavedFlash] = useState(false);

  const kind = deviceKind();
  const KindGlyph = kind === 'phone' ? Smartphone : kind === 'desktop' ? Laptop : MonitorSpeaker;
  const online = devices.filter((d) => d.online).length;

  const save = () => {
    renameDevice(name.trim());
    // The trimmed-empty case falls back to the platform default inside
    // setDeviceName; reflect what actually stuck.
    setName(deviceName());
    setSavedFlash(true);
    window.setTimeout(() => setSavedFlash(false), 1600);
  };

  if (!session) {
    return (
      <div className="prefsBody">
        <div className="prefsSection">
          <Text tone="muted" size="sm">
            Devices appear here once you are signed into a server — AttackFM
            Connect links every signed-in device so any of them can control, or
            take over, what is playing. Sign in under Servers first.
          </Text>
        </div>
      </div>
    );
  }

  return (
    <div className="prefsBody">
      <div className="prefsSection">
        <div className="deviceIdentity">
          <span className="deviceIdentity__glyph" aria-hidden="true">
            <KindGlyph size={22} />
          </span>
          <div className="deviceIdentity__meta">
            <Text weight="semibold">This device</Text>
            <span className="deviceIdentity__status">
              <StatusDot tone={connected ? 'success' : 'neutral'} pulse={connected} size="sm" />
              <Text size="sm" tone="muted">
                {connected
                  ? `Connected · ${online} ${online === 1 ? 'device' : 'devices'} online`
                  : 'Not connected to the hub'}
              </Text>
            </span>
          </div>
        </div>
        <Field
          label="Device name"
          hint="What the other devices' pickers call this one. Saved names announce immediately."
        >
          <div className="deviceRename" data-setting="device-rename">
            <Input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              aria-label="Device name"
              maxLength={40}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
            />
            <Button variant="outline" size="sm" onClick={save}>
              <Save size={14} /> {savedFlash ? 'Saved' : 'Save'}
            </Button>
          </div>
        </Field>
      </div>

      <div className="prefsSection">
        <Field
          label="Play on"
          hint="Every device signed into this account. Tap one to move playback there — it picks up mid-song."
        >
          <DeviceList />
        </Field>
      </div>
    </div>
  );
}
