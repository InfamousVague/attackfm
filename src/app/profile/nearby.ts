//! Who is in the room with you, and whether they are playing something.
//!
//! The native half (src-tauri/src/nearby.rs -> nearby.swift) meshes Bluetooth
//! and peer-to-peer Wi-Fi, so this works in a car where nobody shares a
//! network. Everything here is off until asked: broadcasting is a deliberate
//! act, and switching away or leaving the page takes it down again.
//!
//! A peer is a handle and, when they are hosting, their jam's code - which is
//! already the invitation, so "join" here is the ordinary code join with the
//! typing removed.

import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri, tauriCall } from '../core/tauri.ts';

export interface NearbyPeer {
  handle: string;
  /** Present when they are hosting a jam you could walk into. */
  code?: string;
}

/** Only the app has the native half; a browser tab simply never offers it. */
export function nearbySupported(): boolean {
  return isTauri();
}


/** How often to ask the native side who it can see. Discovery is chatty by
 *  nature; three seconds is fast enough to feel live and slow enough to
 *  leave the radio alone. */
const POLL_MS = 3000;

/**
 * The nearby list, while switched on.
 *
 * `handle` is what other phones will show, and `code` is the jam being
 * hosted - passing it is what turns "I am here" into "I am playing something
 * you can join". Both are re-advertised when they change, because a jam that
 * starts after discovery did should still reach the room.
 */
export function useNearby(handle: string, code: string | null) {
  const [on, setOn] = useState(false);
  const [peers, setPeers] = useState<NearbyPeer[]>([]);
  const live = useRef(false);

  const stop = useCallback(() => {
    live.current = false;
    setOn(false);
    setPeers([]);
    void tauriCall('nearby_stop');
  }, []);

  const start = useCallback(() => {
    if (!nearbySupported()) return;
    live.current = true;
    setOn(true);
  }, []);

  useEffect(() => {
    if (!on) return;
    let alive = true;
    void tauriCall('nearby_start', { handle, code: code ?? null });
    const tick = async () => {
      const raw = await tauriCall<string>('nearby_peers');
      if (!alive || !raw) return;
      try {
        const list = JSON.parse(raw) as NearbyPeer[];
        // Never list yourself: your own advertisement can echo back through
        // the mesh, and "join your own jam" is not an offer.
        setPeers(list.filter((p) => p.handle && p.handle !== handle));
      } catch {
        // Malformed - keep whatever was on screen rather than blanking it.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [on, handle, code]);

  // Leaving the page stops the broadcast; nothing keeps advertising behind
  // the listener's back.
  useEffect(() => () => void tauriCall('nearby_stop'), []);

  return { on, peers, start, stop };
}
