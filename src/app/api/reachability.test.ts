import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The flag is module state seeded at import - including from
 * `navigator.onLine`, which is only trusted in the FALSE direction. Every test
 * that cares about the seed therefore needs its own module instance.
 */
async function fresh() {
  vi.resetModules();
  return import('./reachability.ts');
}

/** jsdom's navigator.onLine is a getter; this is the only way to move it. */
function onLine(value: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => value });
}

beforeEach(() => {
  onLine(true);
});

afterEach(() => {
  onLine(true);
});

describe('the down flag', () => {
  it('starts up', async () => {
    const r = await fresh();
    expect(r.serverSeemsDown()).toBe(false);
  });

  it('treats ONE silence as a hiccup and TWO as an outage', async () => {
    const r = await fresh();
    r.noteServerSilent();
    expect(r.serverSeemsDown()).toBe(false);
    r.noteServerSilent();
    expect(r.serverSeemsDown()).toBe(true);
  });

  it('lets any reply at all put it back up', async () => {
    // A 500 and a 404 are the server TALKING. Only silence means it is gone.
    const r = await fresh();
    r.noteServerSilent();
    r.noteServerSilent();
    r.noteServerAnswered();
    expect(r.serverSeemsDown()).toBe(false);
  });

  it('resets the count on an answer, so two silences either side of one do not add up', async () => {
    const r = await fresh();
    r.noteServerSilent();
    r.noteServerAnswered();
    r.noteServerSilent();
    expect(r.serverSeemsDown()).toBe(false);
  });

  it('counts a dead media element exactly like a silent JSON call', async () => {
    // The player is often the FIRST thing to touch the network after
    // connectivity dies; before this its failures taught the flag nothing.
    const r = await fresh();
    r.noteMediaSilent();
    r.noteMediaSilent();
    expect(r.serverSeemsDown()).toBe(true);
  });
});

describe('what the browser says', () => {
  it('believes a cold boot in airplane mode WITHOUT waiting for two timeouts', async () => {
    // FALSE is a hard fact - radios off, no request can succeed. Starting
    // "up" here left every gate that declines the local copy in the server's
    // favour declining it into a void.
    onLine(false);
    const r = await fresh();
    expect(r.serverSeemsDown()).toBe(true);
  });

  it('never lets a TRUE mark the server up on its own', async () => {
    // Wi-Fi with a dead home hub is emphatically online and can reach nothing.
    const r = await fresh();
    r.noteServerSilent();
    r.noteServerSilent();
    window.dispatchEvent(new Event('online'));
    // The optimism is deliberate and is about the RADIOS, not the hub: the
    // strike count is wiped and the next real requests settle it. Wrong only
    // in the direction that costs a failed stream attempt; the other
    // direction kept working music silent.
    expect(r.serverSeemsDown()).toBe(false);
    r.noteServerSilent();
    expect(r.serverSeemsDown()).toBe(false);
    r.noteServerSilent();
    expect(r.serverSeemsDown()).toBe(true);
  });

  it('goes down at once on an offline event, with no second strike needed', async () => {
    const r = await fresh();
    window.dispatchEvent(new Event('offline'));
    expect(r.serverSeemsDown()).toBe(true);
  });
});

describe('subscribers', () => {
  it('hear a change, and only a change', async () => {
    const r = await fresh();
    let beats = 0;
    const off = r.subscribeReachability(() => {
      beats += 1;
    });
    r.noteServerAnswered();
    expect(beats).toBe(0);
    r.noteServerSilent();
    r.noteServerSilent();
    expect(beats).toBe(1);
    r.noteServerSilent();
    expect(beats).toBe(1);
    r.noteServerAnswered();
    expect(beats).toBe(2);
    off();
    r.noteServerSilent();
    r.noteServerSilent();
    expect(beats).toBe(2);
  });
});

/*
 * SLOW, as opposed to down. A slow connection answers every request and never
 * fails a media element at the transport, so nothing above ever fires for it -
 * which is why a song held on the device with an effect on buffered, retried
 * and stopped instead of playing its copy.
 */
describe('the strained flag', () => {
  const MIN = 60_000;

  it('starts unstrained', async () => {
    const r = await fresh();
    expect(r.streamStrained()).toBe(false);
  });

  it('holds for minutes after the deck notes it, then lifts on its own', async () => {
    const r = await fresh();
    const at = 1_000_000;
    r.noteStreamStrained(at);
    expect(r.streamStrained(at + 1)).toBe(true);
    expect(r.streamStrained(at + 2 * MIN)).toBe(true);
    expect(r.streamStrained(at + 3 * MIN + 1)).toBe(false);
  });

  it('says a bad patch has begun once, not on every stall inside it', async () => {
    const r = await fresh();
    const at = 1_000_000;
    expect(r.noteStreamStrained(at)).toBe(true);
    expect(r.noteStreamStrained(at + 20_000)).toBe(false);
    expect(r.noteStreamStrained(at + 40_000)).toBe(false);
  });

  it('is extended by every note, so a connection that keeps failing stays strained', async () => {
    const r = await fresh();
    const at = 1_000_000;
    r.noteStreamStrained(at);
    r.noteStreamStrained(at + 2 * MIN);
    expect(r.streamStrained(at + 4 * MIN)).toBe(true);
    expect(r.streamStrained(at + 5 * MIN + 1)).toBe(false);
    // ...and a note after it has lifted is a new patch, said again.
    expect(r.noteStreamStrained(at + 6 * MIN)).toBe(true);
  });

  it('is NOT lifted by the server answering - a slow connection answers all day', async () => {
    const r = await fresh();
    r.noteStreamStrained();
    r.noteServerAnswered();
    r.noteServerAnswered();
    expect(r.streamStrained()).toBe(true);
  });

  it('is a different fact from down, in both directions', async () => {
    const r = await fresh();
    r.noteStreamStrained();
    expect(r.serverSeemsDown()).toBe(false);
    const s = await fresh();
    s.noteServerSilent();
    s.noteServerSilent();
    expect(s.serverSeemsDown()).toBe(true);
    expect(s.streamStrained()).toBe(false);
  });
});
