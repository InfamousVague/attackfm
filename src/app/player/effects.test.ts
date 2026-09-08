import { afterEach, describe, expect, it } from 'vitest';

/**
 * The effects rack, arriving from the device that is holding the remote.
 *
 * Same physics as the chain next door (fxChain.test.ts): the rack is applied by
 * the encoder, on the stream the PLAYING device asked for - `fx` in that URL -
 * so a rack set anywhere else colours nothing anybody can hear.
 *
 * ONLY THE RECEIVING HALF IS ASSERTED HERE, and that is a statement about the
 * module rather than about the tests. The rack's UI is parked (the store purges
 * its own storage at boot for exactly that reason), so `commit` has no caller on
 * this device and there is nothing a test could press to make a rack travel. The
 * door it comes back through is what is worth pinning: the day the switches
 * return, they return travelling.
 */
import { activeEffects, applyEffects, effectsOn, effectsParam, setEffectsRelay } from './effects.ts';

afterEach(() => {
  setEffectsRelay(null);
  applyEffects([]);
});

describe('a rack that arrived from the remote', () => {
  it('takes effect here, which is what puts it in the URL', () => {
    applyEffects(['lofi']);
    expect(effectsOn()).toBe(true);
    // `fx` is the whole point: this string is what makes the stream a
    // different URL, and a different URL is what makes the element reload.
    expect(effectsParam()).toBe('lofi');
  });

  it('is not sent back where it came from', () => {
    const sent: (readonly string[])[] = [];
    setEffectsRelay((ids) => sent.push(ids));
    applyEffects(['lofi']);
    expect(sent).toEqual([]);
  });

  it('lands in CATALOGUE order, not in the order the wire spelled it', () => {
    // The order is the URL, and the URL is a cache key: the same rack reached
    // two ways has to be the same encode, or the listener pays twice for one
    // sound. `read()` already normalises storage this way for the same reason.
    applyEffects(['hall', 'lofi']);
    expect(effectsParam()).toBe('lofi,hall');
  });

  it('replaces the rack rather than adding to it', () => {
    applyEffects(['lofi']);
    applyEffects(['hall']);
    expect(activeEffects()).toEqual(['hall']);
  });

  it('an empty rack turns everything off', () => {
    applyEffects(['lofi']);
    applyEffects([]);
    expect(effectsOn()).toBe(false);
    expect(effectsParam()).toBeNull();
  });

  it('refuses an effect this build has never heard of', () => {
    // The ids are the whole contract with stream.rs, which drops a name it does
    // not recognise - so an unknown one buys a transcode and no sound.
    applyEffects(['lofi', 'not-an-effect']);
    expect(activeEffects()).toEqual(['lofi']);
  });

  it('survives a wire that carried nonsense', () => {
    applyEffects(null);
    expect(activeEffects()).toEqual([]);
    applyEffects([7, null, { id: 'lofi' }]);
    expect(activeEffects()).toEqual([]);
  });

  it('drops a frame that says what this device already has', () => {
    // `useEffects` hands Player.tsx the snapshot ARRAY, and its identity is the
    // re-colouring trigger - so committing an identical rack would spend a
    // whole re-encode arriving at the audio already playing. The hub replays
    // the command it was holding when a seat holder returns from a blip, so
    // this frame really does arrive.
    applyEffects(['lofi']);
    const before = activeEffects();
    applyEffects(['lofi']);
    expect(activeEffects()).toBe(before);
  });

  it('still commits when the rack actually changed', () => {
    applyEffects(['lofi']);
    const before = activeEffects();
    applyEffects(['lofi', 'hall']);
    expect(activeEffects()).not.toBe(before);
    expect(activeEffects()).toEqual(['lofi', 'hall']);
  });
});
