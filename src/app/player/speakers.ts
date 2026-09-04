import { useSyncExternalStore } from 'react';
import {
  listSpeakers,
  rescanSpeakers,
  speakerPlayTrack,
  speakerSeekTo,
  speakerSetVolume,
  speakerState,
  speakerTransport,
  type NetworkSpeaker,
} from '../api/speakers.ts';

/**
 * Playing to a speaker on the network, from the page's side.
 *
 * Same shape as casting to a TV, deliberately: THE PAGE STAYS THE BRAIN. The
 * queue, what plays next, shuffle, the sleep timer, the scrubber - all of it
 * keeps living in the Player exactly as when the phone's own speaker is the
 * output. Sending the sound to a kitchen speaker mutes the decks and mirrors
 * what they are doing to the hub, which relays it to the renderer. Nothing
 * about deciding what to play moves, which is what keeps every other feature
 * working untouched while a speaker holds the sound (see cast.ts, which
 * carries the same rule and the same reason).
 *
 * The difference from casting is only who does the talking: a Chromecast is
 * driven by the phone over the LAN, a UPnP speaker is driven by the HUB over
 * SOAP - so every verb here is an API call rather than a native bridge, and
 * the speaker fetches its audio from the hub directly.
 *
 * The snapshot object is REPLACED, never mutated, so useSyncExternalStore's
 * identity contract holds.
 */

export interface SpeakerSession {
  id: string;
  name: string;
  /** Whether this one can have its volume moved. */
  volume: boolean;
}

export interface SpeakerMedia {
  playing: boolean;
  positionMs: number;
  durationMs: number;
}

export interface SpeakersSnapshot {
  /** The hub can see its own network at all. False on a hub in a data centre. */
  reachable: boolean;
  speakers: NetworkSpeaker[];
  /** The speaker holding the sound, or null. */
  session: SpeakerSession | null;
  /** What that speaker reports it is doing, or null before the first poll. */
  media: SpeakerMedia | null;
  /** A look-around is in flight, so the panel can say so rather than look empty. */
  scanning: boolean;
}

const IDLE: SpeakersSnapshot = Object.freeze({
  reachable: false,
  speakers: [],
  session: null,
  media: null,
  scanning: false,
});

let snapshot: SpeakersSnapshot = IDLE;
const listeners = new Set<() => void>();

function set(next: Partial<SpeakersSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listen of listeners) listen();
}

/** Where to send the calls. Set once the server session exists; without it
 *  every verb is a no-op, so callers need no test of their own. */
let hub: { url: string; token: string } | null = null;
export function setSpeakerHub(next: { url: string; token: string } | null): void {
  const changed = hub?.url !== next?.url || hub?.token !== next?.token;
  hub = next;
  // Moving to another server takes the sound with it in the sense that this
  // page can no longer drive that speaker - the seat belonged to the old hub.
  if (changed && !next) stopPolling();
}

export function useSpeakers(): SpeakersSnapshot {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => snapshot,
    () => IDLE,
  );
}

/** Read the hub's list. Cheap: the hub caches its last look for a minute. */
export async function refreshSpeakers(): Promise<void> {
  if (!hub) return;
  try {
    const list = await listSpeakers(hub.url, hub.token);
    set({ speakers: list.speakers ?? [], reachable: list.reachable === true });
  } catch {
    // An older hub has no such route. Nothing to show, and nothing to say -
    // the panel simply has no speakers section.
    set({ speakers: [], reachable: false });
  }
}

/** Look again, now - three seconds of multicast rather than the cache. */
export async function scanSpeakers(): Promise<void> {
  if (!hub) return;
  set({ scanning: true });
  try {
    const list = await rescanSpeakers(hub.url, hub.token);
    set({ speakers: list.speakers ?? [], reachable: true });
  } catch {
    /* leave whatever the last good list was */
  } finally {
    set({ scanning: false });
  }
}

// --- the session -------------------------------------------------------------

let poll: number | null = null;

function stopPolling(): void {
  if (poll != null) window.clearInterval(poll);
  poll = null;
  set({ session: null, media: null });
}

/**
 * Follow the speaker's clock.
 *
 * The renderer is the thing actually making sound, so it - not the muted deck
 * here - is the truth about where the song is. Two seconds is plenty: the deck
 * keeps ticking between polls and only needs correcting when it has drifted.
 */
function startPolling(): void {
  if (poll != null) window.clearInterval(poll);
  poll = window.setInterval(() => {
    const session = snapshot.session;
    if (!hub || !session) return;
    void speakerState(hub.url, hub.token, session.id)
      .then((s) => {
        set({
          media: {
            playing: s.playing === true,
            positionMs: s.positionMs ?? 0,
            durationMs: s.durationMs ?? 0,
          },
        });
      })
      .catch(() => {
        // One missed poll is a blip on a wifi network, not a reason to drop
        // the session and yank the sound back to the phone.
      });
  }, 2000);
}

/** Send the sound to this speaker. */
export function speakerConnect(s: NetworkSpeaker): void {
  set({ session: { id: s.id, name: s.name, volume: s.volume }, media: null });
  startPolling();
}

/** Take the sound back. Stops the renderer rather than leaving it holding a
 *  URL it will keep playing after the app has moved on. */
export function speakerDisconnect(): void {
  const session = snapshot.session;
  if (hub && session) {
    void speakerTransport(hub.url, hub.token, session.id, 'stop').catch(() => {});
  }
  stopPolling();
}

// --- the verbs the Player mirrors -------------------------------------------

export function speakerLoad(trackId: number): void {
  const session = snapshot.session;
  if (!hub || !session) return;
  void speakerPlayTrack(hub.url, hub.token, session.id, trackId).catch(() => {});
}

export function speakerResume(): void {
  const session = snapshot.session;
  if (!hub || !session) return;
  void speakerTransport(hub.url, hub.token, session.id, 'play').catch(() => {});
}

export function speakerPause(): void {
  const session = snapshot.session;
  if (!hub || !session) return;
  void speakerTransport(hub.url, hub.token, session.id, 'pause').catch(() => {});
}

export function speakerSeek(positionMs: number): void {
  const session = snapshot.session;
  if (!hub || !session) return;
  void speakerSeekTo(hub.url, hub.token, session.id, positionMs).catch(() => {});
}

export function speakerVolume(volume: number): void {
  const session = snapshot.session;
  if (!hub || !session || !session.volume) return;
  void speakerSetVolume(hub.url, hub.token, session.id, volume).catch(() => {});
}
