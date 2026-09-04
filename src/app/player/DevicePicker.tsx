import { IconButton, Popover, Text } from '@glacier/react';
import { Airplay, Cast, Check, Globe, Laptop, MonitorSpeaker, Smartphone, Speaker } from '@glacier/icons';
import { useEffect, useState } from 'react';
import { useConnect } from './playbackSync.tsx';
import type { ConnectDevice } from './connect.ts';
import { castConnect, castDisconnect, castDiscovery, useCastSnapshot } from './cast.ts';
import { refreshSpeakers, speakerConnect, speakerDisconnect, useSpeakers } from './speakers.ts';
import { isTauri, tauriCall } from '../core/tauri.ts';

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

/**
 * Whether this shell can put the system's AirPlay sheet up.
 *
 * Asked of the shell rather than sniffed from the platform, because the OTA
 * bundle travels ahead of the native binary: on a shell from before the
 * command the probe simply rejects, which reads as "no" and hides the row
 * instead of leaving a dead one. Asked once - the answer cannot change inside
 * a session.
 */
function useAirplay(): boolean {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (!isTauri()) return;
    void tauriCall<boolean>('airplay_supported')
      .then((yes) => setOk(yes === true))
      .catch(() => setOk(false));
  }, []);
  return ok;
}

/** True when there is a hand-off worth offering: another Connect seat, a
 *  cast device on the network, a cast already running (the way back out must
 *  stay reachable even if the device list momentarily empties), or a system
 *  route sheet this shell can open. */
export function useDevicesAvailable(): boolean {
  const { connected, devices, activeDeviceId } = useConnect();
  const cast = useCastSnapshot();
  const airplay = useAirplay();
  const online = devices.filter((d) => d.online || d.id === activeDeviceId);
  if (connected && online.length >= 2) return true;
  if (airplay) return true;
  return cast.available && (cast.devices.length > 0 || cast.session != null);
}

/** The device rows and their heading, wherever they are mounted. Handles the
 *  nothing-to-pick case itself, since a menu that opened it may outlive the
 *  moment the second device went away. */
export function DeviceList() {
  const { connected, devices, activeDeviceId, thisDeviceId, transfer } = useConnect();
  const cast = useCastSnapshot();
  const airplay = useAirplay();
  const net = useSpeakers();

  // The hub's list, read when the panel opens. It caches its last look for a
  // minute, so this is nearly always free; `scanSpeakers` is the button that
  // actually spends three seconds on the wire.
  useEffect(() => {
    void refreshSpeakers();
  }, []);

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

  if (!hasConnect && !hasCast && !airplay && net.speakers.length === 0) {
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
      {/* Speakers on the hub's own network: an amp, a streamer, a TV that
          runs none of our software. The hub found them and the hub drives
          them, so these rows work on an iPhone exactly as on a laptop -
          nothing here depends on what THIS device can see. */}
      {net.speakers.length > 0 && (
        <>
          <Text tone="muted" size="xs" className="deviceList__head">
            On your network
          </Text>
          {net.speakers.map((s) => {
            const on = net.session?.id === s.id;
            return (
              <button
                key={`net-${s.id}`}
                type="button"
                className="deviceRow"
                data-active={on || undefined}
                onClick={() => (on ? speakerDisconnect() : speakerConnect(s))}
              >
                <span className="deviceRow__icon">
                  <Speaker size={16} />
                </span>
                <span className="deviceRow__body">
                  <span className="deviceRow__name">{s.name}</span>
                  <span className="deviceRow__state">
                    {on ? 'Playing here — tap to stop' : (s.model ?? 'Tap to play here')}
                  </span>
                </span>
                {on && (
                  <span className="deviceRow__check" aria-hidden>
                    <Check size={16} />
                  </span>
                )}
              </button>
            );
          })}
        </>
      )}
      {/* The system's own speakers, behind the sheet iOS insists on drawing
          itself. It cannot be a list - the OS will not say what it can see
          without showing its own picker - so this row is a door rather than a
          destination, and says so. It belongs in this panel all the same:
          AirPlay moves this device's SOUND where Connect moves the DECK, but
          the person holding the phone is asking the one question the panel
          exists to answer. */}
      {airplay && (
        <>
          <Text tone="muted" size="xs" className="deviceList__head">
            AirPlay
          </Text>
          <button
            type="button"
            className="deviceRow"
            onClick={() => void tauriCall('airplay_show').catch(() => {})}
          >
            <span className="deviceRow__icon">
              <Airplay size={16} />
            </span>
            <span className="deviceRow__body">
              <span className="deviceRow__name">Speakers &amp; TVs</span>
              <span className="deviceRow__state">Tap to choose an AirPlay device</span>
            </span>
          </button>
        </>
      )}
    </div>
  );
}

export function DevicePicker({
  always = false,
  size = 'sm',
}: { always?: boolean; size?: 'sm' | 'md' } = {}) {
  const { connected, devices, activeDeviceId, thisDeviceId } = useConnect();
  const cast = useCastSnapshot();
  const airplay = useAirplay();

  // Nothing to pick between: no hub seat to move to, no TV on the network, and
  // no system route sheet to open.
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
  if (!always && !hasConnect && !hasCast && !airplay) return null;

  const activeElsewhere =
    (activeDeviceId != null && activeDeviceId !== thisDeviceId) || cast.session != null;
  const activeHere = cast.session == null && activeDeviceId != null && activeDeviceId === thisDeviceId;
  // Says which of the three things this button currently is, so a screen reader
  // is not told "connect to a device" by a control whose panel will say there
  // are none.
  const label = activeElsewhere
    ? 'Playing on another device — change'
    : hasConnect || hasCast || airplay
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
          size={size}
          aria-label={label}
          data-connected={activeElsewhere || undefined}
          data-active={activeHere || undefined}
          className="deviceTrigger"
        >
          <MonitorSpeaker size={size === 'md' ? 20 : 16} />
        </IconButton>
      }
    >
      <DeviceList />
    </Popover>
  );
}
