import { useSyncExternalStore } from 'react';

/**
 * The effects rack: which colourings are on, and what they are called.
 *
 * The processing itself happens on the SERVER, in the ffmpeg pass that already
 * exists to re-encode a stream, and it has to. The kit's analyser owns the
 * one MediaElementSourceNode an element is ever allowed to have - Web Audio
 * permits exactly one, forever - and hands back a closed meter with no context
 * and no insertion point. There is no seam to hang a filter graph on in the
 * browser at all. The server, meanwhile, is already spawning an encoder per
 * stream with a command line we control, and an `-af` chain there costs a
 * flag. So this module holds only the CHOICE; `server/src/stream.rs` holds the
 * filters, and the ids below are the contract between the two.
 *
 * That the ids are the whole contract is also what makes it safe: the client
 * sends names, never filter strings, and the server drops any name it does not
 * recognise, so nothing here can compose an ffmpeg filter of its own.
 *
 * Two consequences worth knowing about, both surfaced in the panel:
 *  - effects need the server, so a purely local library plays dry;
 *  - a processed stream is a live encode, so it is re-requested rather than
 *    range-seeked, exactly like the metered-connection setting already is.
 */

export type EffectGroup = 'lofi' | 'tone' | 'dirt' | 'move' | 'space' | 'speed';

export interface EffectDef {
  /** The contract with the server. Must exist in stream.rs's EFFECTS. */
  id: string;
  /**
   * Catalogue keys rather than the words themselves. The table is built at
   * import - before a language exists - so the text had to move out of it, and
   * a rack that comes back reads these through t() at render. What it sounds
   * like, in the words someone would use to want it, now lives in en.json
   * beside every other string somebody has to translate.
   */
  labelKey: string;
  blurbKey: string;
  group: EffectGroup;
}

/**
 * Presentation only - the sound of each of these lives in stream.rs. Ordered
 * the way the rack reads, with the one most people are actually after first.
 */
export const EFFECTS: EffectDef[] = [
  { id: 'lofi', labelKey: 'player.effectLofi', blurbKey: 'player.effectLofiBlurb', group: 'lofi' },

  { id: 'lowpass', labelKey: 'player.effectLowPass', blurbKey: 'player.effectLowPassBlurb', group: 'tone' },
  { id: 'radio', labelKey: 'player.effectRadio', blurbKey: 'player.effectRadioBlurb', group: 'tone' },
  { id: 'warm', labelKey: 'player.effectWarm', blurbKey: 'player.effectWarmBlurb', group: 'tone' },

  { id: 'drive', labelKey: 'player.effectDrive', blurbKey: 'player.effectDriveBlurb', group: 'dirt' },
  { id: 'crush', labelKey: 'player.effectCrush', blurbKey: 'player.effectCrushBlurb', group: 'dirt' },

  { id: 'wow', labelKey: 'player.effectWow', blurbKey: 'player.effectWowBlurb', group: 'move' },
  { id: 'tremolo', labelKey: 'player.effectTremolo', blurbKey: 'player.effectTremoloBlurb', group: 'move' },
  { id: 'phaser', labelKey: 'player.effectPhaser', blurbKey: 'player.effectPhaserBlurb', group: 'move' },

  { id: 'room', labelKey: 'player.effectRoom', blurbKey: 'player.effectRoomBlurb', group: 'space' },
  { id: 'hall', labelKey: 'player.effectHall', blurbKey: 'player.effectHallBlurb', group: 'space' },

  { id: 'slow', labelKey: 'player.effectSlow', blurbKey: 'player.effectSlowBlurb', group: 'speed' },
  { id: 'fast', labelKey: 'player.effectFast', blurbKey: 'player.effectFastBlurb', group: 'speed' },
];

const KEY = 'attackfm-effects';

// The rack's UI is gone from the equalizer, and an effect with no visible
// switch must not keep colouring playback from a previous run - re-encoding
// every song for a setting nobody can see or turn off. The store stays (the
// plumbing is load-bearing for the transcode URL), but persisted state is
// purged at load so every session starts dry.
try {
  localStorage.removeItem(KEY);
} catch {
  // Nothing persisted, nothing to purge.
}
const listeners = new Set<() => void>();

function read(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Filtered against the catalogue on the way in - an id retired in a later
    // version would otherwise sit in storage forever, asking for a sound that
    // no longer exists - and put back in catalogue order, which is the same
    // order `_commit` writes. Without that last part a rack restored from
    // storage would spell its `fx` list differently from the identical rack
    // built by clicking, and the two would be different URLs for the same
    // sound: a needless re-encode, and a cache miss for nothing.
    const kept = parsed.filter((id): id is string => typeof id === 'string' && known(id));
    return EFFECTS.filter((e) => kept.includes(e.id)).map((e) => e.id);
  } catch {
    return [];
  }
}

function known(id: string): boolean {
  return EFFECTS.some((e) => e.id === id);
}

let active: string[] = read();
/** Snapshot identity has to be stable, or useSyncExternalStore loops. */
let snapshot: readonly string[] = active;

/*
 * WHERE THE SOUND ACTUALLY IS.
 *
 * The same physics as the chain next door (fxChain.ts says it at length): the
 * rack is applied by the encoder, on the stream the PLAYING device asked for,
 * so a rack set on a device that is only holding the remote colours nothing
 * anybody can hear. This is the wire out to that device, hung on the store so
 * whatever presses the switch travels by existing rather than by remembering.
 *
 * The rack has no switch today - `commit` below is reached only from the wire
 * while the panel is parked - so nothing currently sends. The door is here so
 * that the day the rack comes back it comes back travelling, rather than
 * shipping the identical cross-device bug a second time.
 */
let relay: ((ids: readonly string[]) => void) | null = null;

/** Registered by the Player while ANOTHER device holds the seat. */
export function setEffectsRelay(send: ((ids: readonly string[]) => void) | null): void {
  relay = send;
}

/**
 * The rack's writer, parked with the rack's UI (see the purge above): no
 * switch calls it while there is no switch to press.
 *
 * @param travel false for a rack that ARRIVED from a remote - see
 *   `applyEffects`.
 */
function commit(next: readonly string[], travel = true): void {
  // Catalogue order, not click order, so the panel and the chain agree.
  active = EFFECTS.filter((e) => next.includes(e.id)).map((e) => e.id);
  snapshot = active;
  try {
    localStorage.setItem(KEY, JSON.stringify(active));
  } catch {
    // The choice still applies for this run.
  }
  if (travel) relay?.(snapshot);
  for (const l of listeners) l();
}

/**
 * A rack that arrived FROM the remote.
 *
 * Filtered against the catalogue on the way in exactly as a rack read out of
 * storage is: the ids are the whole contract with stream.rs, and a name this
 * build does not know must not reach the URL.
 *
 * A frame naming the rack this device already has is dropped rather than
 * committed - `useEffects` hands Player.tsx the snapshot ARRAY, whose identity
 * is the re-colouring trigger, so committing an identical rack would spend a
 * whole re-encode arriving at the audio already playing.
 */
export function applyEffects(ids: unknown): void {
  const wanted = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  const next = EFFECTS.filter((e) => wanted.includes(e.id)).map((e) => e.id);
  if (next.length === active.length && next.every((id, i) => id === active[i])) return;
  commit(next, false);
}

export function activeEffects(): readonly string[] {
  return snapshot;
}

export function effectsOn(): boolean {
  return snapshot.length > 0;
}

/** The `fx` query value, or null when the rack is empty. */
export function effectsParam(): string | null {
  return snapshot.length > 0 ? snapshot.join(',') : null;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const EMPTY: readonly string[] = [];

/** The rack's state, live everywhere it is shown. */
export function useEffects(): readonly string[] {
  return useSyncExternalStore(subscribe, activeEffects, () => EMPTY);
}
