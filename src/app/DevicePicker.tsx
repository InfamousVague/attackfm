import { IconButton, Popover, Text } from '@glacier/react';
import { Check, Globe, Laptop, MonitorSpeaker, Smartphone } from '@glacier/icons';
import { useConnect } from './playbackSync.tsx';
import type { ConnectDevice } from './connect.ts';

/**
 * The Connect selector: which device is playing, and a tap to move it.
 *
 * Only shown once a hub is reachable and there is more than one device to
 * choose between - a lone device has nothing to connect to. The trigger goes
 * accent when playback is happening somewhere other than here, the way every
 * "playing on another device" affordance signals it.
 *
 * The list itself is its own export: the desktop player seats it inside the
 * bar's overflow menu rather than behind this dedicated trigger, and both
 * doors show the same rows because they are the same component.
 */

function KindIcon({ kind }: { kind: string }) {
  if (kind === 'phone') return <Smartphone size={16} />;
  if (kind === 'desktop') return <Laptop size={16} />;
  if (kind === 'web') return <Globe size={16} />;
  return <MonitorSpeaker size={16} />;
}

/** True when there is a device hand-off worth offering: a hub connection and
 *  at least one other seat to move playback to. */
export function useDevicesAvailable(): boolean {
  const { connected, devices, activeDeviceId } = useConnect();
  const online = devices.filter((d) => d.online || d.id === activeDeviceId);
  return connected && online.length >= 2;
}

/** The device rows and their heading, wherever they are mounted. Handles the
 *  nothing-to-pick case itself, since a menu that opened it may outlive the
 *  moment the second device went away. */
export function DeviceList() {
  const { connected, devices, activeDeviceId, thisDeviceId, transfer } = useConnect();

  const online = devices.filter((d) => d.online || d.id === activeDeviceId);
  if (!connected || online.length < 2) {
    return (
      <Text tone="muted" size="sm">
        No other devices to play on right now.
      </Text>
    );
  }

  const activeElsewhere = activeDeviceId != null && activeDeviceId !== thisDeviceId;

  const row = (d: ConnectDevice) => {
    const isActive = d.id === activeDeviceId;
    const isThis = d.id === thisDeviceId;
    return (
      <button
        key={d.id}
        type="button"
        className="deviceRow"
        data-active={isActive || undefined}
        disabled={!d.online && !isActive}
        onClick={() => {
          if (!isActive) transfer(d.id);
        }}
      >
        <span className="deviceRow__icon">
          <KindIcon kind={d.kind} />
        </span>
        <span className="deviceRow__body">
          <span className="deviceRow__name">
            {d.name}
            {isThis ? ' (this device)' : ''}
          </span>
          <span className="deviceRow__state">
            {isActive ? 'Playing here' : d.online ? 'Tap to play here' : 'Offline'}
          </span>
        </span>
        {isActive && (
          <span className="deviceRow__check" aria-hidden>
            <Check size={16} />
          </span>
        )}
      </button>
    );
  };

  return (
    <div className="deviceList">
      <Text tone="muted" size="xs" className="deviceList__head">
        {activeElsewhere ? 'Playing on another device' : 'Play on'}
      </Text>
      {online.map(row)}
    </div>
  );
}

export function DevicePicker() {
  const { connected, devices, activeDeviceId, thisDeviceId } = useConnect();

  // Nothing to pick between: the hub is down, or this is the only device.
  const online = devices.filter((d) => d.online || d.id === activeDeviceId);
  if (!connected || online.length < 2) return null;

  const activeElsewhere = activeDeviceId != null && activeDeviceId !== thisDeviceId;
  const activeHere = activeDeviceId != null && activeDeviceId === thisDeviceId;

  return (
    <Popover
      placement="top-end"
      aria-label="Connect to a device"
      className="devicePanel"
      trigger={
        <IconButton
          variant="ghost"
          size="sm"
          aria-label="Connect to a device"
          data-connected={activeElsewhere || undefined}
          data-active={activeHere || undefined}
          className="deviceTrigger"
        >
          <MonitorSpeaker size={16} />
        </IconButton>
      }
    >
      <DeviceList />
    </Popover>
  );
}
