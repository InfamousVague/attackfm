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

/**
 * The voice's live loudness, published while a clip plays - the Now Playing
 * art breathes with it ('afm-dj-level', 0..1). A WebAudio analyser taps the
 * element; the interval is a timer rather than requestAnimationFrame so the
 * meter keeps publishing when the app is backgrounded or the pane hidden.
 * Metering is decoration: any failure (no AudioContext, an interrupted one)
 * silently leaves the waves on their own clock.
 */
function meter(el: HTMLAudioElement): () => void {
  try {
    const Ctx = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return () => {};
    const ctx = new Ctx();
    const src = ctx.createMediaElementSource(el);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    const buf = new Uint8Array(analyser.frequencyBinCount);
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    const tick = window.setInterval(() => {
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) {
        const d = (v - 128) / 128;
        sum += d * d;
      }
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
      window.dispatchEvent(new CustomEvent('afm-dj-level', { detail: { level } }));
    }, 33);
    return () => {
      window.clearInterval(tick);
      window.dispatchEvent(new CustomEvent('afm-dj-level', { detail: { level: 0 } }));
      void ctx.close().catch(() => {});
    };
  } catch {
    return () => {};
  }
}

/** The clip on the air right now, so a superseding speaker can cut it off
 *  mid-word instead of talking over its tail. */
let onAir: HTMLAudioElement | null = null;

function playOne(url: string): Promise<void> {
  return new Promise((resolve) => {
    const el = new Audio(url);
    el.volume = 1;
    const stopMeter = meter(el);
    const done = () => {
      if (onAir === el) onAir = null;
      stopMeter();
      resolve();
    };
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('error', done, { once: true });
    // Nothing else ever pauses these elements, so a pause IS the cut-off -
    // and a natural end fires 'ended', never 'pause'.
    el.addEventListener('pause', done, { once: true });
    onAir = el;
    void el.play().catch(done);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* One speaker: a new set of beats supersedes whatever was mid-sentence, and
   the duck lifts exactly once, by whichever call is still current. */
let speaking = 0;

/** Stop whatever the mouth is saying, mid-word, and lift the duck - for a
 *  Skip button, or a surface unmounting under its own narration. */
export function hushBeats(): void {
  speaking += 1;
  onAir?.pause();
  duck(false);
}

/** Speak a block's beats in order, ducking the music underneath. The caller
 *  owns the preference gate: the set bridge checks the DJ switch, the date
 *  briefing its own - one mouth, two consents. `onBeat` hears each clip's
 *  ORIGINAL index as it starts, failed fetches skipped - a read-along can
 *  light the line being spoken. */
export async function speakBeats(
  session: ServerSession,
  ids: string[],
  onBeat?: (index: number) => void,
): Promise<void> {
  if (ids.length === 0) return;
  const mine = ++speaking;
  // Whoever was mid-sentence stops NOW - with lore on every track, letting
  // the old clip run to its natural end means two DJs talking at once.
  onAir?.pause();
  const fetched = await Promise.all(ids.map((id) => clipUrl(session, id)));
  const takes = fetched
    .map((url, index) => ({ url, index }))
    .filter((t): t is { url: string; index: number } => t.url !== null);
  if (mine !== speaking) return;
  if (takes.length === 0) {
    // This call owns the floor but has nothing to say: lower the lights the
    // superseded speaker was told not to touch, or the duck stays stuck.
    duck(false);
    return;
  }
  duck(true);
  try {
    for (const [n, take] of takes.entries()) {
      if (mine !== speaking) return;
      if (n > 0) await sleep(240);
      if (mine !== speaking) return;
      onBeat?.(take.index);
      await playOne(take.url);
    }
  } finally {
    // The superseding call has its own duck(true) in flight; only the call
    // that still owns the floor lowers the lights on the way out.
    if (mine === speaking) duck(false);
  }
}
