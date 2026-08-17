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
  label: string;
  /** What it sounds like, in the words someone would use to want it. */
  blurb: string;
  group: EffectGroup;
}

/**
 * Presentation only - the sound of each of these lives in stream.rs. Ordered
 * the way the rack reads, with the one most people are actually after first.
 */
export const EFFECTS: EffectDef[] = [
  { id: 'lofi', label: 'Lofi', blurb: 'Tape, dust and a low ceiling', group: 'lofi' },

  { id: 'lowpass', label: 'Through the wall', blurb: 'Everything above the mids, gone', group: 'tone' },
  { id: 'radio', label: 'AM radio', blurb: 'Thin, boxy, mid-range only', group: 'tone' },
  { id: 'warm', label: 'Warm', blurb: 'Extremes rolled off and glued', group: 'tone' },

  { id: 'drive', label: 'Attack pedal', blurb: 'Overdrive - the peaks grit up', group: 'dirt' },
  { id: 'crush', label: 'Bitcrush', blurb: 'Fewer bits, coarser clock', group: 'dirt' },

  { id: 'wow', label: 'Tape wow', blurb: 'The wobble of a worn tape', group: 'move' },
  { id: 'tremolo', label: 'Tremolo', blurb: 'Volume pulsing in time', group: 'move' },
  { id: 'phaser', label: 'Phaser', blurb: 'A sweep moving through it', group: 'move' },

  { id: 'room', label: 'Room', blurb: 'Played in a small hard room', group: 'space' },
  { id: 'hall', label: 'Hall', blurb: 'Further away, longer tail', group: 'space' },

  { id: 'slow', label: 'Slowed', blurb: 'A little under tempo', group: 'speed' },
  { id: 'fast', label: 'Sped up', blurb: 'A little over tempo', group: 'speed' },
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
    // order `commit` writes. Without that last part a rack restored from
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

function commit(next: string[]): void {
  // Catalogue order, not click order, so the panel and the chain agree.
  active = EFFECTS.filter((e) => next.includes(e.id)).map((e) => e.id);
  snapshot = active;
  try {
    localStorage.setItem(KEY, JSON.stringify(active));
  } catch {
    // The choice still applies for this run.
  }
  for (const l of listeners) l();
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
