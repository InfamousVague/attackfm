import { Button, Field, Input, StatusDot, Text } from '@glacier/react';
import { Laptop, MonitorSpeaker, Save, Smartphone } from '@glacier/icons';
import { useState } from 'react';
import { deviceKind, deviceName } from '../player/connect.ts';
import { DeviceList } from '../player/DevicePicker.tsx';
import { useConnect } from '../player/playbackSync.tsx';
import { useServerSession } from '../servers/serverSession.tsx';
import { useT } from '../i18n/LocaleShell.tsx';

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
  const t = useT();
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
          <Text tone="muted" size="sm">{t('devices.signInFirst')}</Text>
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
            <Text weight="semibold">{t('devices.thisDevice')}</Text>
            <span className="deviceIdentity__status">
              <StatusDot tone={connected ? 'success' : 'neutral'} pulse={connected} size="sm" />
              <Text size="sm" tone="muted">
                {/* One sentence with the tally inside it: "device"/"devices"
                    is the count's grammar, not a choice this file can make. */}
                {connected ? t('devices.connected', { count: online }) : t('devices.offline')}
              </Text>
            </span>
          </div>
        </div>
        <Field label={t('devices.name')} hint={t('devices.nameHint')}>
          <div className="deviceRename" data-setting="device-rename">
            <Input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              aria-label={t('devices.name')}
              maxLength={40}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save();
              }}
            />
            <Button variant="outline" size="sm" onClick={save}>
              <Save size={14} /> {savedFlash ? t('devices.saved') : t('common.save')}
            </Button>
          </div>
        </Field>
      </div>

      <div className="prefsSection">
        <Field label={t('devices.playOn')} hint={t('devices.playOnHint')}>
          <DeviceList />
        </Field>
      </div>
    </div>
  );
}
