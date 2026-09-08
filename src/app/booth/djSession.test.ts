import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../api/http.ts';
import type { Track } from '../core/tauri.ts';

/**
 * The running DJ set.
 *
 * `startDjRun` is the one start path every launcher shares - the Booth's
 * hero, the Now Playing button, a station - and its job is to turn the hub's
 * blocks of TRACK IDS into a queue of this library's own rows, plus four maps
 * the bridge reads to toast a line, speak a beat and explain a pick.
 *
 * The rules that matter are all about what falls out along the way: an id
 * this library cannot resolve, a song the listener has already refused this
 * sitting, and a block whose first track was one of those - because "the
 * line each run opens with" is keyed by the first track that actually made
 * it into the queue, not by the first id the hub named.
 */
vi.mock('../server.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../server.ts')>()),
  fetchDj: vi.fn(),
}));

import { fetchDj } from '../server.ts';
import { artistKey, noteNo, resetSaidNo, trackKey } from './saidNo.ts';
import { currentDjRun, djWhy, inDjRun, publishDjRun, startDjRun, subscribeDjRun } from './djSession.ts';

const asked = vi.mocked(fetchDj);
const session = { url: 'https://matt.attack.fm', token: 't' } as unknown as ServerSession;

function song(id: number, over: Partial<Track> = {}): Track {
  return {
    path: `afm://${id}`,
    title: `Song ${id}`,
    artist: 'Somebody',
    album: 'A record',
    duration: 1,
    ...over,
  } as Track;
}

const library = [1, 2, 3, 4, 5].map((n) => song(n));
const pathsOf = (queue: Track[]) => queue.map((t) => t.path);

beforeEach(() => {
  resetSaidNo();
  publishDjRun(null);
});

afterEach(() => {
  resetSaidNo();
  publishDjRun(null);
});

describe('startDjRun - building the queue', () => {
  it('turns the hub’s ids into this library’s rows, in the hub’s order', async () => {
    asked.mockResolvedValue({
      ai: true,
      vibe: '',
      blocks: [
        { say: 'Opening up.', trackIds: [3, 1] },
        { say: 'And now this.', trackIds: [2] },
      ],
    } as never);
    const { queue, ai } = await startDjRun(session, library);
    expect(pathsOf(queue)).toEqual(['afm://3', 'afm://1', 'afm://2']);
    expect(ai).toBe(true);
  });

  it('skips an id this library does not hold', async () => {
    asked.mockResolvedValue({
      ai: false,
      vibe: '',
      blocks: [{ say: 'Here.', trackIds: [1, 999, 2] }],
    } as never);
    const { queue } = await startDjRun(session, library);
    expect(pathsOf(queue)).toEqual(['afm://1', 'afm://2']);
  });

  it('carries the filter and the seed to the hub', async () => {
    asked.mockResolvedValue({ ai: false, vibe: '', blocks: [] } as never);
    await startDjRun(session, library, 'late night', { filter: 'genre:jazz' });
    expect(asked).toHaveBeenCalledWith(session, 'late night', undefined, { filter: 'genre:jazz' });
  });

  it('publishes nothing at all for a set that resolved to no songs', async () => {
    asked.mockResolvedValue({ ai: false, vibe: '', blocks: [{ say: 'Here.', trackIds: [999] }] } as never);
    const { queue } = await startDjRun(session, library);
    expect(queue).toEqual([]);
    // Not an empty run: a run with no songs in it would leave the bridge
    // watching a set that can never end.
    expect(currentDjRun()).toBeNull();
  });
});

describe('startDjRun - a no is honoured even when the hub has not caught up', () => {
  it('drops a song refused this sitting', async () => {
    noteNo(trackKey(2));
    asked.mockResolvedValue({ ai: false, vibe: '', blocks: [{ say: 'Here.', trackIds: [1, 2, 3] }] } as never);
    const { queue } = await startDjRun(session, library);
    expect(pathsOf(queue)).toEqual(['afm://1', 'afm://3']);
  });

  it('drops every song by an artist refused this sitting', async () => {
    const mixed = [song(1, { artist: 'Wham!' }), song(2, { artist: 'Keeper' }), song(3, { artist: 'Wham!' })];
    noteNo(artistKey('wham!'));
    asked.mockResolvedValue({ ai: false, vibe: '', blocks: [{ say: 'Here.', trackIds: [1, 2, 3] }] } as never);
    const { queue } = await startDjRun(session, mixed);
    expect(pathsOf(queue)).toEqual(['afm://2']);
  });

  it('keeps the song when nothing has been refused', async () => {
    // The third case: the same set, the same hub reply, no ledger entry - and
    // all three songs come through. Without it, the two tests above would
    // pass against a `startDjRun` that dropped everything.
    asked.mockResolvedValue({ ai: false, vibe: '', blocks: [{ say: 'Here.', trackIds: [1, 2, 3] }] } as never);
    const { queue } = await startDjRun(session, library);
    expect(pathsOf(queue)).toEqual(['afm://1', 'afm://2', 'afm://3']);
  });
});

describe('startDjRun - the line each run opens with', () => {
  it('keys the line by the block’s FIRST song', async () => {
    asked.mockResolvedValue({
      ai: true,
      vibe: '',
      blocks: [
        { say: 'Opening up.', trackIds: [1, 2] },
        { say: 'And now this.', trackIds: [3] },
      ],
    } as never);
    await startDjRun(session, library);
    const run = currentDjRun()!;
    expect(run.lineAt.get('afm://1')).toBe('Opening up.');
    expect(run.lineAt.get('afm://2')).toBeUndefined();
    expect(run.lineAt.get('afm://3')).toBe('And now this.');
  });

  it('moves the line to the first song that SURVIVED the block', async () => {
    // The block's first id was refused, so the line has to open over the
    // song that actually plays first - otherwise the set starts in silence
    // and the patter never fires.
    noteNo(trackKey(1));
    asked.mockResolvedValue({
      ai: true,
      vibe: '',
      blocks: [{ say: 'Opening up.', trackIds: [1, 2] }],
    } as never);
    await startDjRun(session, library);
    expect(currentDjRun()!.lineAt.get('afm://2')).toBe('Opening up.');
  });

  it('keeps a block with nothing to say out of the map', async () => {
    asked.mockResolvedValue({ ai: false, vibe: '', blocks: [{ say: '   ', trackIds: [1] }] } as never);
    await startDjRun(session, library);
    expect(currentDjRun()!.lineAt.size).toBe(0);
  });

  it('files the spoken clips beside the line, on the same song', async () => {
    asked.mockResolvedValue({
      ai: true,
      vibe: '',
      blocks: [{ say: 'Opening up.', trackIds: [1, 2], voice: ['clip-a', 'clip-b'] }],
    } as never);
    await startDjRun(session, library);
    expect(currentDjRun()!.voiceAt.get('afm://1')).toEqual(['clip-a', 'clip-b']);
  });

  it('files lore per SONG, not per block', async () => {
    asked.mockResolvedValue({
      ai: true,
      vibe: '',
      blocks: [
        {
          say: 'Opening up.',
          trackIds: [1, 2],
          lore: { '2': { say: 'Recorded in a barn.', voice: ['clip-c'] } },
        },
      ],
    } as never);
    await startDjRun(session, library);
    const run = currentDjRun()!;
    expect(run.loreAt.get('afm://1')).toBeUndefined();
    expect(run.loreAt.get('afm://2')).toEqual({ line: 'Recorded in a barn.', voice: ['clip-c'] });
  });

  it('gives lore with no clips an empty voice rather than undefined', async () => {
    asked.mockResolvedValue({
      ai: true,
      vibe: '',
      blocks: [{ say: 'x', trackIds: [1], lore: { '1': { say: 'A fact.' } } }],
    } as never);
    await startDjRun(session, library);
    expect(currentDjRun()!.loreAt.get('afm://1')).toEqual({ line: 'A fact.', voice: [] });
  });
});

describe('the run as app state', () => {
  it('says which songs the DJ chose', async () => {
    asked.mockResolvedValue({ ai: false, vibe: '', blocks: [{ say: 'x', trackIds: [1, 2] }] } as never);
    await startDjRun(session, library);
    expect(inDjRun('afm://1')).toBe(true);
    expect(inDjRun('afm://5')).toBe(false);
  });

  it('says nothing about any song with no set running', () => {
    expect(inDjRun('afm://1')).toBe(false);
    expect(djWhy('afm://1')).toBeUndefined();
  });

  it('carries the hub’s reason for a pick, and only where it gave one', async () => {
    asked.mockResolvedValue({
      ai: true,
      vibe: '',
      blocks: [{ say: 'x', trackIds: [1, 2] }],
      why: { '1': 'You had this on repeat in March.' },
    } as never);
    await startDjRun(session, library);
    expect(djWhy('afm://1')).toBe('You had this on repeat in March.');
    expect(djWhy('afm://2')).toBeUndefined();
  });

  it('tells subscribers when a set starts and when it ends', async () => {
    const heard = vi.fn();
    const off = subscribeDjRun(heard);
    asked.mockResolvedValue({ ai: false, vibe: '', blocks: [{ say: 'x', trackIds: [1] }] } as never);
    await startDjRun(session, library);
    expect(heard).toHaveBeenCalledTimes(1);
    publishDjRun(null);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
    publishDjRun(null);
    expect(heard).toHaveBeenCalledTimes(2);
  });
});
