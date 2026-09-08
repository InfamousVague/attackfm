import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../api/http.ts';

/**
 * Taking a part out of what is playing.
 *
 * Two rules here cost real money when they are wrong, and neither is visible
 * from the screen:
 *
 *   - `drop` FORCES the encoder. Sending it for a song the server cannot
 *     honour spends a transcode - and a listener's lossless stream - to
 *     achieve exactly nothing. So `stemDropParam` answers null unless this
 *     song is KNOWN to have parts.
 *   - Every distinct value in the URL is a fresh ffmpeg encode. A fader
 *     dragged across its range at two decimal places asks for a hundred of
 *     them; quantised to 0.05 the same drag asks for at most twenty.
 *
 * `applies` and `state` are module-scope, so each test uses its own track ids
 * and puts the faders back at full afterwards.
 */
vi.mock('../api/stems.ts', () => ({ stemStatus: vi.fn() }));

import { stemStatus } from '../api/stems.ts';
import {
  clearStemDrop,
  isStemDropped,
  noteStemsFor,
  setStemDropped,
  setStemLevel,
  stemDrop,
  stemDropOnTrack,
  stemDropParam,
  stemGain,
  stemsKnownFor,
  subscribeStemDrop,
} from './stemDrop.ts';

const asked = vi.mocked(stemStatus);
const session = { url: 'https://matt.attack.fm', token: 't' } as unknown as ServerSession;

/** Track ids are handed out per test so the `applies` cache cannot leak. */
let next = 1000;
const anId = () => (next += 1);

beforeEach(() => {
  clearStemDrop();
});

afterEach(() => {
  clearStemDrop();
});

describe('the faders', () => {
  it('starts every part at full', () => {
    expect(stemGain('vocals')).toBe(1);
    expect(isStemDropped('vocals')).toBe(false);
    expect(stemDrop().gains).toEqual({});
  });

  it('holds a part faint rather than only in or out', () => {
    setStemLevel('vocals', 0.2);
    expect(stemGain('vocals')).toBe(0.2);
    // Faint is not dropped: the vocal is under everything else, not gone.
    expect(isStemDropped('vocals')).toBe(false);
  });

  it('takes a part fully out and puts it back', () => {
    setStemDropped('vocals', true);
    expect(isStemDropped('vocals')).toBe(true);
    setStemDropped('vocals', false);
    expect(isStemDropped('vocals')).toBe(false);
    // Full is ABSENT from the map, so "everything at full" is empty - which
    // is what `anyMoved()` reads to decide whether to spend anything at all.
    expect(stemDrop().gains).toEqual({});
  });

  it('clamps a level to 0..1', () => {
    setStemLevel('vocals', -3);
    expect(stemGain('vocals')).toBe(0);
    setStemLevel('vocals', 9);
    expect(stemGain('vocals')).toBe(1);
    expect(stemDrop().gains).toEqual({});
  });

  it('tells subscribers when a fader moves', () => {
    const heard = vi.fn();
    const off = subscribeStemDrop(heard);
    setStemLevel('vocals', 0.5);
    expect(heard).toHaveBeenCalledTimes(1);
    off();
    setStemLevel('vocals', 0.25);
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('says nothing on a clear that clears nothing', () => {
    const heard = vi.fn();
    const off = subscribeStemDrop(heard);
    clearStemDrop();
    expect(heard).not.toHaveBeenCalled();
    off();
  });
});

describe('stemDropParam - what reaches the URL', () => {
  it('is null with every fader at full', () => {
    const id = anId();
    noteStemsFor(id, true);
    expect(stemDropParam(id)).toBeNull();
  });

  it('is null for a song not KNOWN to have parts', () => {
    // The expensive case: `drop` forces the encoder, so an unasked song must
    // not carry one. Absent means unasked, not absent-means-no.
    const id = anId();
    setStemDropped('vocals', true);
    expect(stemsKnownFor(id)).toBeUndefined();
    expect(stemDropParam(id)).toBeNull();
  });

  it('is null for a song the server said has NO parts', () => {
    const id = anId();
    setStemDropped('vocals', true);
    noteStemsFor(id, false);
    expect(stemDropParam(id)).toBeNull();
  });

  it('carries the drop once the song is known to have parts', () => {
    // The third case, and the one that makes the two nulls above mean
    // something: with the same drop set, a song that HAS parts gets it.
    const id = anId();
    setStemDropped('vocals', true);
    noteStemsFor(id, true);
    expect(stemDropParam(id)).toBe('vocals:0.00');
  });

  it('is null with no track at all', () => {
    setStemDropped('vocals', true);
    expect(stemDropParam(null)).toBeNull();
  });

  it('names only the parts turned below full', () => {
    const id = anId();
    setStemLevel('vocals', 0.2);
    setStemLevel('drums', 1);
    noteStemsFor(id, true);
    expect(stemDropParam(id)).toBe('vocals:0.20');
  });

  it('quantises to 0.05 - the whole point being how many URLs a drag makes', () => {
    const id = anId();
    noteStemsFor(id, true);
    // Six positions a finger can land on inside one 5% step, all of which
    // must ask the server for the same encode.
    const urls = new Set<string>();
    for (const g of [0.2801, 0.29, 0.3, 0.305, 0.31, 0.3199]) {
      setStemLevel('vocals', g);
      urls.add(stemDropParam(id)!);
    }
    expect([...urls]).toEqual(['vocals:0.30']);

    // A whole drag across the fader asks for a bounded number of encodes,
    // not one per pixel - which is the number this quantisation exists to
    // hold down. Twenty-one, not twenty: see the next test.
    const all = new Set<string>();
    for (let step = 0; step <= 100; step += 1) {
      // The fader's own resolution: StemsRoom's Slider is 0..100 integers
      // and hands over `v / 100`.
      setStemLevel('vocals', step / 100);
      const param = stemDropParam(id);
      if (param) all.add(param);
    }
    expect(all.size).toBe(21);
  });

  it('writes a NO-OP drop at 99% - a transcode spent to change nothing', () => {
    /*
     * FOUND BY THIS SUITE, and left as it is because the fix is a behaviour
     * change rather than a test fix.
     *
     * `anyMoved()` reads the fader's own value (0.99 < 1, so a drop is set),
     * but the URL is quantised to 0.05 and rounds it back to `1.00` - full.
     * So the one step below the top of a fader forces the encoder, gives up
     * the lossless direct-stream path, and asks the server to produce audio
     * identical to no drop at all. Reachable from the UI: StemsRoom's fader
     * is a 0..100 integer slider, so 99 is one drag-step from the top.
     *
     * Pinned here so the day somebody fixes it - by quantising before the
     * `< 1` test, or by dropping full-valued parts out of the URL - this
     * test fails and says which behaviour changed and why it was deliberate.
     */
    const id = anId();
    noteStemsFor(id, true);
    setStemLevel('vocals', 0.99);
    expect(stemDropParam(id)).toBe('vocals:1.00');
  });

  it('rounds to the nearest step, not down', () => {
    const id = anId();
    noteStemsFor(id, true);
    setStemLevel('vocals', 0.38);
    expect(stemDropParam(id)).toBe('vocals:0.40');
  });

  it('keeps the fader’s own resolution underneath', () => {
    // Only the URL is quantised: `state.gains` is what the UI draws, and a
    // fader that snapped to 5% on screen would feel notched.
    setStemLevel('vocals', 0.31);
    expect(stemGain('vocals')).toBe(0.31);
  });

  it('writes every moved part, comma-joined', () => {
    const id = anId();
    setStemLevel('vocals', 0);
    setStemLevel('drums', 0.5);
    noteStemsFor(id, true);
    const param = stemDropParam(id)!;
    expect(param.split(',').sort()).toEqual(['drums:0.50', 'vocals:0.00']);
  });
});

describe('noteStemsFor - the revision signal', () => {
  it('bumps the revision when a song is LEARNED to have parts under a live drop', () => {
    // The drop itself did not change; what changed is whether it applies to
    // the song already loaded, and nothing downstream could see that.
    const id = anId();
    setStemDropped('vocals', true);
    const before = stemDrop().revision;
    noteStemsFor(id, true);
    expect(stemDrop().revision).toBe(before + 1);
  });

  it('does not bump for a NO', () => {
    // Publishing a "no" would reload a song to arrive at the URL it has.
    const id = anId();
    setStemDropped('vocals', true);
    const before = stemDrop().revision;
    noteStemsFor(id, false);
    expect(stemDrop().revision).toBe(before);
  });

  it('does not bump when no drop is set', () => {
    const id = anId();
    const before = stemDrop().revision;
    noteStemsFor(id, true);
    expect(stemDrop().revision).toBe(before);
  });

  it('does not bump twice for the same song', () => {
    const id = anId();
    setStemDropped('vocals', true);
    noteStemsFor(id, true);
    const after = stemDrop().revision;
    noteStemsFor(id, true);
    expect(stemDrop().revision).toBe(after);
  });
});

describe('stemDropOnTrack - when a request is spent', () => {
  it('spends nothing for somebody who has never touched the Stems tab', async () => {
    stemDropOnTrack(session, anId());
    await Promise.resolve();
    expect(asked).not.toHaveBeenCalled();
  });

  it('asks once per song while a drop is set', async () => {
    const id = anId();
    asked.mockResolvedValue({ stems: ['vocals'] } as never);
    setStemDropped('vocals', true);
    stemDropOnTrack(session, id);
    await Promise.resolve();
    await Promise.resolve();
    expect(asked).toHaveBeenCalledWith(session, id);
    // A queue that comes back round asks once.
    stemDropOnTrack(session, id);
    await Promise.resolve();
    expect(asked).toHaveBeenCalledTimes(1);
    expect(stemsKnownFor(id)).toBe(true);
  });

  it('does not ask twice while the first ask is still in flight', async () => {
    const id = anId();
    let land: (v: unknown) => void = () => {};
    asked.mockReturnValueOnce(new Promise((res) => (land = res)) as never);
    setStemDropped('vocals', true);
    stemDropOnTrack(session, id);
    stemDropOnTrack(session, id);
    expect(asked).toHaveBeenCalledTimes(1);
    land({ stems: [] });
    await Promise.resolve();
  });

  it('leaves a failed ask UNRECORDED rather than recorded as a no', async () => {
    // A no is cached for the session, so a network blip would mute the
    // feature for that song until relaunch.
    const id = anId();
    asked.mockRejectedValueOnce(new Error('offline'));
    setStemDropped('vocals', true);
    stemDropOnTrack(session, id);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(stemsKnownFor(id)).toBeUndefined();

    // And it may be asked again - the third case, which is what "unrecorded"
    // is actually for.
    asked.mockResolvedValueOnce({ stems: ['vocals'] } as never);
    stemDropOnTrack(session, id);
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
    expect(asked).toHaveBeenCalledTimes(2);
    expect(stemsKnownFor(id)).toBe(true);
  });

  it('asks nothing off a hub, or with no track', async () => {
    setStemDropped('vocals', true);
    stemDropOnTrack(null, anId());
    stemDropOnTrack(session, null);
    await Promise.resolve();
    expect(asked).not.toHaveBeenCalled();
  });
});
