import { request } from './http.ts';

/**
 * Speakers on the hub's own network - UPnP/DLNA renderers (server/src/dlna.rs).
 *
 * The hub does the looking because discovery is a multicast and only reaches
 * the wifi the looker is on. That also means a hub in a data centre honestly
 * has nothing to report, which is what `reachable` distinguishes: "no speakers
 * on your network" and "this hub is not on your network" read the same in an
 * empty list and are entirely different problems.
 */

export interface NetworkSpeaker {
  /** The device's UDN, stable across reboots. */
  id: string;
  name: string;
  model?: string;
  /** Whether it exposes RenderingControl, i.e. whether volume can be moved. */
  volume: boolean;
}

export interface SpeakerList {
  speakers: NetworkSpeaker[];
  /** False when the hub has no LAN address - a VPS can never see a speaker. */
  reachable: boolean;
}

export interface SpeakerState {
  positionMs: number | null;
  durationMs: number | null;
  playing: boolean;
  /** The renderer's own word: PLAYING, PAUSED_PLAYBACK, STOPPED, TRANSITIONING. */
  state: string | null;
}

export function listSpeakers(url: string, token: string): Promise<SpeakerList> {
  return request<SpeakerList>(url, '/api/speakers', { token });
}

export function rescanSpeakers(url: string, token: string): Promise<SpeakerList> {
  return request<SpeakerList>(url, '/api/speakers/rescan', { method: 'POST', token });
}

/** Add a speaker the search cannot see, by its description URL. */
export function addSpeaker(
  url: string,
  token: string,
  location: string,
): Promise<{ speaker: NetworkSpeaker }> {
  return request(url, '/api/speakers/add', {
    method: 'POST',
    token,
    body: JSON.stringify({ location }),
  });
}

const enc = (id: string) => encodeURIComponent(id);

export function speakerPlayTrack(
  url: string,
  token: string,
  id: string,
  trackId: number,
): Promise<unknown> {
  return request(url, `/api/speakers/${enc(id)}/play`, {
    method: 'POST',
    token,
    body: JSON.stringify({ trackId }),
  });
}

export function speakerTransport(
  url: string,
  token: string,
  id: string,
  action: 'play' | 'pause' | 'stop',
): Promise<unknown> {
  return request(url, `/api/speakers/${enc(id)}/transport`, {
    method: 'POST',
    token,
    body: JSON.stringify({ action }),
  });
}

export function speakerSeekTo(
  url: string,
  token: string,
  id: string,
  positionMs: number,
): Promise<unknown> {
  return request(url, `/api/speakers/${enc(id)}/seek`, {
    method: 'POST',
    token,
    body: JSON.stringify({ positionMs: Math.max(0, Math.round(positionMs)) }),
  });
}

export function speakerSetVolume(
  url: string,
  token: string,
  id: string,
  volume: number,
): Promise<unknown> {
  return request(url, `/api/speakers/${enc(id)}/volume`, {
    method: 'POST',
    token,
    body: JSON.stringify({ volume: Math.min(1, Math.max(0, volume)) }),
  });
}

export function speakerState(url: string, token: string, id: string): Promise<SpeakerState> {
  return request<SpeakerState>(url, `/api/speakers/${enc(id)}/state`, { token });
}
