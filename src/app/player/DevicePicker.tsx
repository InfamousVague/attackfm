import { IconButton, Popover, Text } from '@glacier/react';
import { Cast, Check, Globe, Laptop, MonitorSpeaker, Smartphone } from '@glacier/icons';
import { useEffect } from 'react';
import { useConnect } from './playbackSync.tsx';
import type { ConnectDevice } from './connect.ts';
import { castConnect, castDisconnect, castDiscovery, useCastSnapshot } from './cast.ts';

/**
 * The Connect selector: which device is playing, and a tap to move it.
 *
 * Two kinds of destination share the one panel, because to the person holding
 * the phone they are the same question - "where should the music come out?" -
 * even though the machinery underneath could not be more different. A Connect
 * device is another INSTALL of the app holding a seat at the hub; a
 * Chromecast is a dumb speaker on the LAN that this phone feeds directly
 * (cast.ts). The rows say which is which by their words, not by making the
 * listener learn the architecture.
 *
 * Only shown when there is somewhere for sound to go: a hub with a second
 * device, or a cast device on the network. The trigger goes accent when
 * playback is happening somewhere other than here - another seat or a TV -
 * the way every "playing elsewhere" affordance signals it.
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

/** True when there is a hand-off worth offering: another Connect seat, a
 *  cast device on the network, or a cast already running (the way back out
 *  must stay reachable even if the device list momentarily empties). */
export function useDevicesAvailable(): boolean {
  const { connected, devices, activeDeviceId } = useConnect();
  const cast = useCastSnapshot();
  const online = devices.filter((d) => d.online || d.id === activeDeviceId);
  if (connected && online.length >= 2) return true;
  return cast.available && (cast.devices.length > 0 || cast.session != null);
}

/** The device rows and their heading, wherever they are mounted. Handles the
 *  nothing-to-pick case itself, since a menu that opened it may outlive the
 *  moment the second device went away. */
export function DeviceList() {
  const { connected, devices, activeDeviceId, thisDeviceId, transfer } = useConnect();
  const cast = useCastSnapshot();

  // Active scan only while these rows are on screen - it is the mode Google
  // says to reserve for an open chooser, because it wakes every cast device
  // on the network over and over.
  useEffect(() => {
    if (!cast.available) return;
    castDiscovery(true);
    return () => castDiscovery(false);
  }, [cast.available]);

  const online = devices.filter((d) => d.online || d.id === activeDeviceId);
  const hasConnect = connected && online.length >= 2;
  const hasCast = cast.available && (cast.devices.length > 0 || cast.session != null);

  if (!hasConnect && !hasCast) {
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

  // The TV rows. A connected TV shows even when discovery has lost sight of
  // it, so "stop casting" cannot vanish while the music is still up there.
  const castingTo = cast.session?.device ?? null;
  const castRows = cast.devices.map((d) => {
    const isCasting = castingTo != null && d.name === castingTo;
    return (
      <button
        key={`cast-${d.id}`}
        type="button"
        className="deviceRow"
        data-active={isCasting || undefined}
        onClick={() => {
          if (isCasting) castDisconnect();
          else castConnect(d.id);
        }}
      >
        <span className="deviceRow__icon">
          <Cast size={16} />
        </span>
        <span className="deviceRow__body">
          <span className="deviceRow__name">{d.name}</span>
          <span className="deviceRow__state">
            {isCasting ? 'Casting — tap to stop' : 'Tap to cast'}
          </span>
        </span>
        {isCasting && (
          <span className="deviceRow__check" aria-hidden>
            <Check size={16} />
          </span>
        )}
      </button>
    );
  });
  if (castingTo != null && !cast.devices.some((d) => d.name === castingTo)) {
    castRows.unshift(
      <button
        key="cast-current"
        type="button"
        className="deviceRow"
        data-active
        onClick={() => castDisconnect()}
      >
        <span className="deviceRow__icon">
          <Cast size={16} />
        </span>
        <span className="deviceRow__body">
          <span className="deviceRow__name">{castingTo}</span>
          <span className="deviceRow__state">Casting — tap to stop</span>
        </span>
        <span className="deviceRow__check" aria-hidden>
          <Check size={16} />
        </span>
      </button>,
    );
  }

  return (
    <div className="deviceList">
      {hasConnect && (
        <>
          <Text tone="muted" size="xs" className="deviceList__head">
            {activeElsewhere ? 'Playing on another device' : 'Play on'}
          </Text>
          {online.map(row)}
        </>
      )}
      {hasCast && (
        <>
          <Text tone="muted" size="xs" className="deviceList__head">
            Cast to
          </Text>
          {castRows}
        </>
      )}
    </div>
  );
}

export function DevicePicker({ always = false }: { always?: boolean } = {}) {
  const { connected, devices, activeDeviceId, thisDeviceId } = useConnect();
  const cast = useCastSnapshot();

  // Nothing to pick between: no hub seat to move to, and no TV on the network.
  const online = devices.filter((d) => d.online || d.id === activeDeviceId);
  const hasConnect = connected && online.length >= 2;
  const hasCast = cast.available && (cast.devices.length > 0 || cast.session != null);
  /*
   * `always` keeps the button on surfaces where WHERE THE SOUND IS GOING is part
   * of what the surface is for.
   *
   * Hiding it until a second device appears is right for the strip's overflow
   * and for settings: a row that opens onto "nothing to pick" is noise in a
   * menu. It is wrong on the Now Playing screen, where the question is not only
   * "can I move this" but "where is this playing" - and a control that exists
   * only when you already have two devices is one nobody discovers before they
   * buy the second one.
   *
   * Safe because DeviceList answers the empty case itself, in words, rather than
   * opening an empty panel - and because the trigger still carries data-active,
   * so with one device it reads as "playing here" rather than as a dead button.
   */
  if (!always && !hasConnect && !hasCast) return null;

  const activeElsewhere =
    (activeDeviceId != null && activeDeviceId !== thisDeviceId) || cast.session != null;
  const activeHere = cast.session == null && activeDeviceId != null && activeDeviceId === thisDeviceId;
  // Says which of the three things this button currently is, so a screen reader
  // is not told "connect to a device" by a control whose panel will say there
  // are none.
  const label = activeElsewhere
    ? 'Playing on another device — change'
    : hasConnect || hasCast
      ? 'Connect to a device'
      : 'Playing on this device';

  return (
    <Popover
      placement="top-end"
      aria-label={label}
      className="devicePanel"
      trigger={
        <IconButton
          variant="ghost"
          size="sm"
          aria-label={label}
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
