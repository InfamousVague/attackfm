import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * THE SOUND HAS TO REACH THE DEVICE THAT IS PLAYING.
 *
 * The chain is compiled by the encoder, on the stream the playing device asked
 * for - `fx2` in that device's URL. So a filter tapped on a device that is only
 * holding the remote changed nothing anybody could hear: put "slowed" on the
 * desktop while the phone was streaming and the phone kept playing the record
 * dry, for that song and every song after. That is the bug this file is about,
 * and it is the same bug the mix had one release earlier (stemDrop.test.ts).
 *
 * `state` is module scope and persisted, so every test here puts the chain back
 * empty and takes the relay off afterwards.
 */
import {
  applyFxChain,
  fxChain,
  fxChainOn,
  fxChainParam,
  setFxChain,
  setFxChainRelay,
  silenceFxChain,
  type FxNode,
} from './fxChain.ts';
// The wire's own shape lives with the wire, which is where the relay's
// signature reads it from too.
import type { FxWireNode } from './connect.ts';

/** A box, spelled the way a room spells one before it goes in the chain. */
function box(t: string, params: Record<string, number>, on = true): FxNode {
  return { t, on, params, key: `k-${t}` };
}

beforeEach(() => {
  setFxChain([]);
});

afterEach(() => {
  setFxChainRelay(null);
  setFxChain([]);
});

describe('the chain, when another device is the one playing', () => {
  it('sends a filter over the wire', () => {
    const sent: FxWireNode[][] = [];
    setFxChainRelay((nodes) => sent.push(nodes));
    setFxChain([box('lp', { f: 4000 })]);
    expect(sent).toEqual([[{ t: 'lp', on: true, params: { f: 4000 } }]]);
  });

  it('sends the WHOLE chain, not the box that moved', () => {
    const sent: FxWireNode[][] = [];
    setFxChain([box('bass', { g: 6, f: 100 })]);
    setFxChainRelay((nodes) => sent.push(nodes));
    // What a room does when a second pedal is added: it writes the whole list.
    setFxChain([box('bass', { g: 6, f: 100 }), box('lp', { f: 4000 })]);
    expect(sent.at(-1)?.map((n) => n.t)).toEqual(['bass', 'lp']);
  });

  it('carries the boxes that are switched OFF as well', () => {
    // The receiving device is handed the room, not a diff of it: a box parked
    // off is part of what the console over there is showing, and dropping it
    // here would make the two consoles disagree the moment it is switched on.
    const sent: FxWireNode[][] = [];
    setFxChainRelay((nodes) => sent.push(nodes));
    setFxChain([box('lp', { f: 4000 }, false)]);
    expect(sent.at(-1)).toEqual([{ t: 'lp', on: false, params: { f: 4000 } }]);
  });

  it('sends the clear too - an empty chain is an instruction', () => {
    const sent: FxWireNode[][] = [];
    setFxChain([box('lp', { f: 4000 })]);
    setFxChainRelay((nodes) => sent.push(nodes));
    // The Filters room's "clear", and what every room reaches for first.
    setFxChain([]);
    expect(sent).toEqual([[]]);
  });

  it('sends the console’s all-off, which is not a clear', () => {
    const sent: FxWireNode[][] = [];
    setFxChain([box('lp', { f: 4000 })]);
    setFxChainRelay((nodes) => sent.push(nodes));
    silenceFxChain();
    expect(sent.at(-1)).toEqual([{ t: 'lp', on: false, params: { f: 4000 } }]);
  });

  it('leaves the list keys at home', () => {
    // `key` is client-side list identity and says so on its declaration. The
    // receiving device draws its own list and mints its own.
    const sent: FxWireNode[][] = [];
    setFxChainRelay((nodes) => sent.push(nodes));
    setFxChain([box('lp', { f: 4000 })]);
    expect(sent.at(-1)![0]).not.toHaveProperty('key');
  });

  it('keeps the chain here as well, so this device’s own console reads right', () => {
    setFxChainRelay(() => {});
    setFxChain([box('lp', { f: 4000 })]);
    expect(fxChainOn()).toBe(true);
    expect(fxChain().nodes.map((n) => n.t)).toEqual(['lp']);
  });

  it('stops sending the moment the seat comes back', () => {
    const sent: FxWireNode[][] = [];
    setFxChainRelay((nodes) => sent.push(nodes));
    setFxChainRelay(null);
    setFxChain([box('lp', { f: 4000 })]);
    expect(sent).toEqual([]);
  });
});

describe('a chain that arrived from the remote', () => {
  it('takes effect here, which is what puts it in the URL', () => {
    applyFxChain([{ t: 'lp', on: true, params: { f: 4000 } }]);
    expect(fxChainOn()).toBe(true);
    // `fx2` is the whole point: this string is what makes the stream a
    // different URL, and a different URL is what makes the element reload.
    expect(fxChainParam()).toBe('[{"t":"lp","f":4000}]');
  });

  it('is not sent back where it came from', () => {
    const sent: FxWireNode[][] = [];
    setFxChainRelay((nodes) => sent.push(nodes));
    applyFxChain([{ t: 'lp', on: true, params: { f: 4000 } }]);
    expect(sent).toEqual([]);
  });

  it('replaces the chain rather than merging into it', () => {
    // A filter REPLACES the chain (FiltersRoom says why: one signal path), so
    // a chain arriving from over there has to land the same way.
    setFxChain([box('bass', { g: 6, f: 100 })]);
    applyFxChain([{ t: 'lp', on: true, params: { f: 4000 } }]);
    expect(fxChain().nodes.map((n) => n.t)).toEqual(['lp']);
  });

  it('an empty chain takes everything off', () => {
    setFxChain([box('lp', { f: 4000 })]);
    applyFxChain([]);
    expect(fxChain().nodes).toEqual([]);
    expect(fxChainParam()).toBeNull();
  });

  it('refuses a node this build has never heard of', () => {
    // The tags are the contract with the server's fx.rs. A name from a newer
    // client must not reach the URL, where it would be dropped silently and
    // read as a weak effect rather than a missing one.
    applyFxChain([{ t: 'not-a-node', on: true, params: {} }]);
    expect(fxChain().nodes).toEqual([]);
  });

  it('clamps a parameter the wire had no business carrying', () => {
    applyFxChain([{ t: 'lp', on: true, params: { f: 999_999 } }]);
    expect(fxChain().nodes[0]!.params.f).toBe(20_000);
    applyFxChain([{ t: 'lp', on: true, params: { f: Number.NaN } }]);
    // Not a number at all falls back to the spec's default, not to zero.
    expect(fxChain().nodes[0]!.params.f).toBe(18_000);
  });

  it('gives every arriving box a list key of its own', () => {
    applyFxChain([{ t: 'lp', on: true, params: { f: 4000 } }]);
    expect(fxChain().nodes[0]!.key).toBeTruthy();
  });

  it('survives a wire that carried nonsense', () => {
    applyFxChain(null);
    expect(fxChain().nodes).toEqual([]);
    applyFxChain(['not a node', 7, null]);
    expect(fxChain().nodes).toEqual([]);
  });

  it('hands the surfaces a NEW object, which is the change signal', () => {
    // Player.tsx's re-colouring effect compares the chain by reference, and
    // that comparison is the whole mechanism that reloads the stream. A store
    // that mutated in place would apply the filter to the next song only.
    const before = fxChain();
    applyFxChain([{ t: 'lp', on: true, params: { f: 4000 } }]);
    expect(fxChain()).not.toBe(before);
  });
});

/**
 * THE FRAME THAT SAYS NOTHING NEW.
 *
 * A re-colour costs an open connection and a fresh transcode from the current
 * position - the encoder IS the chain, so there is no cheaper way to change
 * one. Player.tsx's re-colouring effect triggers on the chain's OBJECT
 * IDENTITY, so committing an identical chain would spend that whole reload
 * arriving at the audio already playing. And an identical chain is not
 * hypothetical: the hub replays the last command it was holding when a seat
 * holder comes back from a socket blip.
 */
describe('a chain that says what this device already has', () => {
  it('is dropped rather than committed', () => {
    setFxChain([box('lp', { f: 4000 })]);
    const before = fxChain();
    applyFxChain([{ t: 'lp', on: true, params: { f: 4000 } }]);
    expect(fxChain()).toBe(before);
  });

  it('is dropped even when it spells the boxes differently', () => {
    // The keys differ and the parameter came over as a partial - the wire's
    // spelling, not the store's. Sameness is about the SOUND.
    setFxChain([box('lp', { f: 18_000 })]);
    const before = fxChain();
    applyFxChain([{ t: 'lp', on: true, params: {} }]);
    expect(fxChain()).toBe(before);
  });

  it('still commits when one knob moved', () => {
    setFxChain([box('lp', { f: 4000 })]);
    const before = fxChain();
    applyFxChain([{ t: 'lp', on: true, params: { f: 4100 } }]);
    expect(fxChain()).not.toBe(before);
    expect(fxChain().nodes[0]!.params.f).toBe(4100);
  });

  it('still commits when a box was only switched off', () => {
    setFxChain([box('lp', { f: 4000 })]);
    applyFxChain([{ t: 'lp', on: false, params: { f: 4000 } }]);
    expect(fxChainOn()).toBe(false);
  });
});
