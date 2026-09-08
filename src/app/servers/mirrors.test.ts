import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerSession } from '../api/http.ts';

/*
 * Three seams, all of them so this file can be about ROUTING rather than about
 * networking:
 *
 *  - `../server.ts` for the cached index each box's holdings are built from;
 *  - `./serverNames.ts`, which imports this module back (the probe teaches it
 *    a box's name), so the real one would be a cycle in a test;
 *  - the diag log, which is a sink.
 */
const { loadCachedIndex, syncLibrary, rememberServerName } = vi.hoisted(() => ({
  loadCachedIndex: vi.fn(),
  syncLibrary: vi.fn(),
  rememberServerName: vi.fn(),
}));
vi.mock('../server.ts', () => ({ loadCachedIndex, syncLibrary }));
vi.mock('./serverNames.ts', () => ({ rememberServerName }));
vi.mock('../diag/diagLog.ts', () => ({
  recordDiag: vi.fn(),
  describeFailure: (e: unknown) => String(e),
  redactUrl: (u: string) => u,
}));

const HOME = 'https://home.example.com';
const VPS = 'https://vps.example.com';
const NAS = 'https://nas.example.com';

const session: ServerSession = {
  url: HOME,
  token: 'tok',
  streamToken: 'home-stream',
  username: 'matt',
  isAdmin: false,
};

interface IndexRow {
  id: number;
  artist: string;
  title: string;
}

/** Each box's own row ids for the same two songs - which is the whole problem
 *  the fold exists to solve. */
function index(rows: Record<string, IndexRow[]>, rev = 1) {
  loadCachedIndex.mockImplementation((url: string) => ({ rev, tracks: rows[url] ?? [] }));
}

/** A module with no health, no holdings and no stickiness carried over. */
async function fresh() {
  vi.resetModules();
  return import('./mirrors.ts');
}

function mirror(url: string, streamToken = `${url}-stream`) {
  return { url, token: 't', streamToken, username: 'matt', isAdmin: false, addedAt: 0 };
}

/** Time a probe exactly, so the smoothing can be asserted rather than sampled. */
function timeProbe(samples: number[]) {
  let at = 0;
  let i = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => {
    // Each probe reads the clock twice: before the fetch and after it.
    const value = i % 2 === 0 ? at : at + (samples[Math.floor(i / 2)] ?? 0);
    i += 1;
    if (i % 2 === 0) at += 10_000;
    return value;
  });
}

beforeEach(() => {
  localStorage.clear();
  loadCachedIndex.mockReset();
  syncLibrary.mockReset();
  loadCachedIndex.mockReturnValue({ rev: 1, tracks: [] });
});

describe('trackKey', () => {
  it('is the house fold of artist then title, joined by U+0001', async () => {
    /*
     * The separator is a LITERAL control character in mirrors.ts, invisible in
     * every editor, and it is a cross-language contract: server/src/mirror.rs
     * builds the same key as `fold(artist)\u{1}fold(title)`. A tidy-up that
     * strips it, or a reformatter that eats it, would leave the availability
     * map quietly missing songs both boxes hold - so it is asserted by code
     * point, not by pasting the character back in.
     */
    const { trackKey, fold } = await fresh();
    const key = trackKey('Kendrick Lamar', 'Alright');
    expect(key).toBe(`${fold('Kendrick Lamar')}\u0001${fold('Alright')}`);
    expect(key.split('\u0001')).toEqual(['kendrick lamar', 'alright']);
  });

  it('cannot be made ambiguous by moving a word across the join', async () => {
    // Without a separator, ("Air", "Bag") and ("A", "IrBag") are one key.
    const m = await fresh();
    expect(m.trackKey('Air', 'Bag')).not.toBe(m.trackKey('A', 'Irbag'));
  });

  it('joins two taggers spelling the same song differently', async () => {
    const { trackKey } = await fresh();
    expect(trackKey("Beyoncé", "Don't Hurt Yourself")).toBe(trackKey('Beyonce', 'Dont Hurt Yourself'));
    expect(trackKey('Sigur Rós', 'Hoppípolla')).toBe(trackKey('sigur ros', 'hoppipolla'));
  });

  it('still tells two different songs apart', async () => {
    const { trackKey } = await fresh();
    expect(trackKey('Drake', 'Passionfruit')).not.toBe(trackKey('Drake', 'Passion Fruit '));
  });
});

describe('the mirror ledger', () => {
  it('starts empty, and says routing is not even a question', async () => {
    const m = await fresh();
    expect(m.mirrorList()).toEqual([]);
    expect(m.mirrorsActive()).toBe(false);
  });

  it('replaces credentials for a box already on the list rather than filing a second card', async () => {
    const m = await fresh();
    m.addMirror(mirror(VPS, 'old'));
    m.addMirror(mirror(VPS, 'new'));
    expect(m.mirrorList()).toHaveLength(1);
    expect(m.mirrorList()[0]?.streamToken).toBe('new');
  });

  it('does not let a trailing slash make one box into two', async () => {
    const m = await fresh();
    m.addMirror(mirror(VPS));
    m.addMirror(mirror(`${VPS}/`, 'newer'));
    expect(m.mirrorList()).toHaveLength(1);
    expect(m.mirrorList()[0]?.url).toBe(VPS);
    m.removeMirror(`${VPS}//`);
    expect(m.mirrorList()).toEqual([]);
  });

  it('ignores a stored row with no stream token, which could serve nothing', async () => {
    localStorage.setItem(
      'attackfm-mirrors',
      JSON.stringify([{ url: VPS, streamToken: '' }, { url: NAS, streamToken: 'ok' }, { streamToken: 'x' }]),
    );
    const m = await fresh();
    expect(m.mirrorList().map((x) => x.url)).toEqual([NAS]);
  });

  it('reads unparseable storage as no mirrors', async () => {
    localStorage.setItem('attackfm-mirrors', 'not json');
    const m = await fresh();
    expect(m.mirrorList()).toEqual([]);
  });

  it('tells its listeners when the list or the switch moves', async () => {
    const m = await fresh();
    let beats = 0;
    const off = m.subscribeMirrors(() => {
      beats += 1;
    });
    m.addMirror(mirror(VPS));
    m.setRoutingPref(false);
    expect(beats).toBe(2);
    off();
    m.addMirror(mirror(NAS));
    expect(beats).toBe(2);
  });

  it('routes by default once a mirror exists, and stops when switched off', async () => {
    const m = await fresh();
    expect(m.routingPref()).toBe(true);
    m.setRoutingPref(false);
    expect(m.routingPref()).toBe(false);
    m.setRoutingPref(true);
    expect(m.routingPref()).toBe(true);
  });
});

describe('probe', () => {
  it('times the box, and learns what it says about itself', async () => {
    const m = await fresh();
    timeProbe([120]);
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ name: 'AttackFM (home)', owner: 'Matt', imports: true }) }),
      ),
    );
    await expect(m.probe(HOME)).resolves.toBe(120);
    expect(m.healthOf(HOME)).toMatchObject({ ok: true, latencyMs: 120, imports: true });
    expect(rememberServerName).toHaveBeenCalledWith(HOME, { name: 'AttackFM (home)', owner: 'Matt' });
  });

  it('smooths a new reading rather than jumping to it', async () => {
    // 0.3 of the new sample: one slow response must not move "this box is near".
    const m = await fresh();
    timeProbe([100, 200]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })));
    await m.probe(HOME);
    await expect(m.probe(HOME)).resolves.toBeCloseTo(130, 6);
  });

  it('keeps "did not say" apart from "no", for a box older than the field', async () => {
    // NULL IS NOT FALSE: reading an old box's silence as "cannot download"
    // moves imports off a box that has been fetching them fine.
    const m = await fresh();
    timeProbe([10]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ name: 'old box' }) })));
    await m.probe(HOME);
    expect(m.healthOf(HOME)?.imports).toBeNull();
  });

  it('keeps the last known latency and capability when one probe fails', async () => {
    // A box that failed one probe from a flaky network has not become
    // permanently far away, and has not lost the ability to download.
    const m = await fresh();
    timeProbe([90]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ imports: true }) })));
    await m.probe(HOME);
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    await expect(m.probe(HOME)).resolves.toBeNull();
    expect(m.healthOf(HOME)).toMatchObject({ ok: false, latencyMs: 90, imports: true });
  });

  it('counts a non-200 as a failed probe', async () => {
    const m = await fresh();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 502 })));
    await expect(m.probe(HOME)).resolves.toBeNull();
    expect(m.healthOf(HOME)).toMatchObject({ ok: false, latencyMs: null });
  });

  it('has no health for a box nobody has asked about', async () => {
    const m = await fresh();
    expect(m.healthOf(NAS)).toBeNull();
  });

  it('cache-busts, so a middlebox 304 is not what gets timed', async () => {
    const m = await fresh();
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
    vi.stubGlobal('fetch', fetchSpy);
    await m.probe(HOME);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/^https:\/\/home\.example\.com\/api\/server\?probe=\d+$/);
    expect(init.cache).toBe('no-store');
  });
});

/** Give a box a health reading without going through the network. */
async function withHealth(m: Awaited<ReturnType<typeof fresh>>, readings: Record<string, number | false>) {
  for (const [url, value] of Object.entries(readings)) {
    if (value === false) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('down'))));
      await m.probe(url);
      continue;
    }
    timeProbe([value]);
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })));
    await m.probe(url);
    vi.mocked(performance.now).mockRestore();
  }
}

describe('pickSource', () => {
  const rows = {
    [HOME]: [{ id: 1, artist: 'Kendrick Lamar', title: 'Alright' }],
    [VPS]: [{ id: 900, artist: 'Kendrick Lamar', title: 'Alright' }],
    [NAS]: [{ id: 700, artist: 'Kendrick Lamar', title: 'Alright' }],
  };

  it('has nothing to decide with no mirrors', async () => {
    const m = await fresh();
    index(rows);
    expect(m.pickSource(session, 1)).toBeNull();
  });

  it('does nothing at all when routing is switched off', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    m.setRoutingPref(false);
    await withHealth(m, { [HOME]: 300, [VPS]: 10 });
    expect(m.pickSource(session, 1)).toBeNull();
  });

  it('sends a song to a mirror that holds it and is nearer', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    await withHealth(m, { [HOME]: 300, [VPS]: 10 });
    expect(m.pickSource(session, 1)).toEqual({
      url: VPS,
      streamToken: `${VPS}-stream`,
      // The mirror's OWN row id for the same song - the two boxes never agree
      // on ids, which is why the fold is the join.
      trackId: 900,
      primary: false,
    });
  });

  it('keeps the song where it is when the session server is not measured', async () => {
    // An unprobed home is treated as near rather than far: without a
    // measurement the incumbent keeps the song.
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    await withHealth(m, { [VPS]: 5 });
    expect(m.pickSource(session, 1)).toBeNull();
  });

  it('leaves for any healthy holder when the session server is not answering', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    await withHealth(m, { [HOME]: false, [VPS]: 400 });
    expect(m.pickSource(session, 1)?.url).toBe(VPS);
  });

  it('makes a challenger a clear quarter faster before it takes an established route', async () => {
    // Stickiness is not a nicety: the stream token rides the query string, so
    // changing route busts every cached URL for that song.
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    await withHealth(m, { [HOME]: 100, [VPS]: 99 });
    expect(m.pickSource(session, 1)?.url).toBe(VPS);

    // Home is now genuinely faster - but not by enough. The route holds.
    await withHealth(m, { [HOME]: 80 });
    expect(m.pickSource(session, 1)?.url).toBe(VPS);

    // Past the margin (99 * 0.75 = 74.25), it comes home. The reading has to
    // be low enough to drag the SMOOTHED figure under it: 94 * 0.7 + 10 * 0.3.
    await withHealth(m, { [HOME]: 10 });
    expect(m.pickSource(session, 1)).toBeNull();
  });

  it('ignores a mirror that is unreachable, or has never been timed', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    m.addMirror(mirror(NAS));
    await withHealth(m, { [HOME]: 300, [VPS]: false });
    // NAS holds the song and is unprobed; VPS holds it and is down.
    expect(m.pickSource(session, 1)).toBeNull();
  });

  it('ignores a mirror that does not hold the song', async () => {
    const m = await fresh();
    index({ ...rows, [VPS]: [{ id: 900, artist: 'Someone Else', title: 'Something Else' }] });
    m.addMirror(mirror(VPS));
    await withHealth(m, { [HOME]: 300, [VPS]: 1 });
    expect(m.pickSource(session, 1)).toBeNull();
  });

  it('leaves a song the session index cannot name where it was found', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    await withHealth(m, { [HOME]: 300, [VPS]: 1 });
    expect(m.pickSource(session, 4242)).toBeNull();
  });

  it('picks the nearest of several holders', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    m.addMirror(mirror(NAS));
    await withHealth(m, { [HOME]: 300, [VPS]: 50, [NAS]: 20 });
    expect(m.pickSource(session, 1)?.url).toBe(NAS);
  });
});

describe('artFallbackUrl', () => {
  const rows = {
    [HOME]: [{ id: 1, artist: 'Kendrick Lamar', title: 'Alright' }],
    [VPS]: [{ id: 900, artist: 'Kendrick Lamar', title: 'Alright' }],
  };
  const failed = `${HOME}/api/art/abc?t=home-stream&track=1`;

  it('asks another holder for the cover the session server would not serve', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    expect(m.artFallbackUrl(session, failed)).toBe(
      `${VPS}/api/art/track/900?t=${encodeURIComponent(`${VPS}-stream`)}`,
    );
  });

  it('carries the size through, so a thumbnail stays a thumbnail', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    expect(m.artFallbackUrl(session, `${failed}&size=160`)).toContain('&size=160');
  });

  it('has no answer for a URL that is not the session server s', async () => {
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    expect(m.artFallbackUrl(session, `${VPS}/api/art/abc?track=1`)).toBeNull();
  });

  it('has no answer when the failing URL does not name its song', async () => {
    // The inert `track` param IS the identity; without it there is nothing to
    // look up on another box.
    const m = await fresh();
    index(rows);
    m.addMirror(mirror(VPS));
    expect(m.artFallbackUrl(session, `${HOME}/api/art/abc?t=home-stream`)).toBeNull();
  });

  it('has no answer when nobody else holds the song', async () => {
    const m = await fresh();
    index({ ...rows, [VPS]: [] });
    m.addMirror(mirror(VPS));
    expect(m.artFallbackUrl(session, failed)).toBeNull();
  });

  it('skips a holder known to be down and takes the next one', async () => {
    const m = await fresh();
    index({ ...rows, [NAS]: [{ id: 700, artist: 'Kendrick Lamar', title: 'Alright' }] });
    m.addMirror(mirror(VPS));
    m.addMirror(mirror(NAS));
    await withHealth(m, { [VPS]: false });
    expect(m.artFallbackUrl(session, failed)).toContain(`${NAS}/api/art/track/700`);
  });
});

describe('keyForTrackId', () => {
  it('rebuilds its map when the index it came from has moved on', async () => {
    const m = await fresh();
    index({ [HOME]: [{ id: 1, artist: 'Kendrick Lamar', title: 'Alright' }] }, 1);
    expect(m.keyForTrackId(HOME, 1)).toBe(m.trackKey('Kendrick Lamar', 'Alright'));
    // A sync landed: id 1 is a different song now, at a new rev.
    index({ [HOME]: [{ id: 1, artist: 'Drake', title: 'Passionfruit' }] }, 2);
    expect(m.keyForTrackId(HOME, 1)).toBe(m.trackKey('Drake', 'Passionfruit'));
  });

  it('is null for an id the index does not carry', async () => {
    const m = await fresh();
    index({ [HOME]: [] });
    expect(m.keyForTrackId(HOME, 9)).toBeNull();
  });
});

describe('refreshHoldings', () => {
  it('keeps what was cached when a mirror cannot be reached', async () => {
    // A mirror that cannot be reached is not a mirror that lost its music.
    const m = await fresh();
    index({ [VPS]: [{ id: 900, artist: 'Kendrick Lamar', title: 'Alright' }] });
    syncLibrary.mockRejectedValue(new Error('offline'));
    await expect(m.refreshHoldings(mirror(VPS))).resolves.toBe(1);
  });

  it('takes the fresh listing when it comes', async () => {
    const m = await fresh();
    index({ [VPS]: [] });
    syncLibrary.mockResolvedValue({
      tracks: [
        { id: 900, artist: 'Kendrick Lamar', title: 'Alright' },
        { id: 901, artist: 'Drake', title: 'Passionfruit' },
      ],
    });
    await expect(m.refreshHoldings(mirror(VPS))).resolves.toBe(2);
  });
});
