import { useEffect, useState } from 'react';
import type { ServerSession } from '../api/http.ts';

/**
 * The DJ's mouth, client side: fetches the cached clips the server minted
 * (voice.rs - a library line, then the artist's name as its own beat) and
 * speaks them over the music, ducked. Strictly additive to the text toast:
 * no clips, no preference, no session - the set plays exactly as before.
 *
 * Ducking rides one event ('afm-duck') that the Player folds into its own
 * fader maths, because the decks' volume is a braid of loudness gain, the
 * crossfade's seats and the user's fader - a second hand on the elements
 * themselves would fight all three.
 */

const PREF = 'attackfm-dj-voice';

export function djVoiceEnabled(): boolean {
  try {
    return localStorage.getItem(PREF) !== 'off';
  } catch {
    return true;
  }
}

export function setDjVoice(on: boolean): void {
  try {
    if (on) localStorage.removeItem(PREF);
    else localStorage.setItem(PREF, 'off');
  } catch {
    // Storage refused: the choice still holds for this run via the event.
  }
  window.dispatchEvent(new Event('afm-dj-voice'));
}

/** Clip bytes by id - content-addressed on the server, so never refetched. */
const clips = new Map<string, Promise<string | null>>();

function clipUrl(session: ServerSession, id: string): Promise<string | null> {
  const hit = clips.get(id);
  if (hit) return hit;
  const p = fetch(`${session.url}/api/voice/${id}`, {
    headers: { authorization: `Bearer ${session.token}` },
  })
    .then(async (r) => (r.ok ? URL.createObjectURL(await r.blob()) : null))
    .catch(() => null);
  clips.set(id, p);
  return p;
}

let talking = false;

function duck(on: boolean): void {
  // The duck and the talking signal travel together but stay two events:
  // one is a mixing instruction the Player folds into its fader, the other
  // is a fact about the DJ that any surface may dress itself by.
  talking = on;
  window.dispatchEvent(new CustomEvent('afm-duck', { detail: { on } }));
  window.dispatchEvent(new CustomEvent('afm-dj-talking', { detail: { on } }));
}

/** Whether the DJ's voice is speaking right now, as React state - the Now
 *  Playing art wears its speech waves off this. */
export function useDjTalking(): boolean {
  const [on, setOn] = useState(() => talking);
  useEffect(() => {
    const listen = (e: Event) => setOn(Boolean((e as CustomEvent).detail?.on));
    window.addEventListener('afm-dj-talking', listen);
    return () => window.removeEventListener('afm-dj-talking', listen);
  }, []);
  return on;
}

function playOne(url: string): Promise<void> {
  return new Promise((resolve) => {
    const el = new Audio(url);
    el.volume = 1;
    const done = () => resolve();
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('error', done, { once: true });
    void el.play().catch(done);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* One speaker: a new set of beats supersedes whatever was mid-sentence, and
   the duck lifts exactly once, by whichever call is still current. */
let speaking = 0;

/** Speak a block's beats in order, ducking the music underneath. */
export async function speakBeats(session: ServerSession, ids: string[]): Promise<void> {
  if (!djVoiceEnabled() || ids.length === 0) return;
  const mine = ++speaking;
  const urls = (await Promise.all(ids.map((id) => clipUrl(session, id)))).filter(
    (u): u is string => u !== null,
  );
  if (mine !== speaking || urls.length === 0) return;
  duck(true);
  try {
    for (const [i, url] of urls.entries()) {
      if (mine !== speaking) return;
      if (i > 0) await sleep(240);
      if (mine !== speaking) return;
      await playOne(url);
    }
  } finally {
    // The superseding call has its own duck(true) in flight; only the call
    // that still owns the floor lowers the lights on the way out.
    if (mine === speaking) duck(false);
  }
}
