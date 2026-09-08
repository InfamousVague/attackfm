import { describe, expect, it } from 'vitest';
import { hostOf } from './ShareJam.tsx';

/**
 * The address on the share card.
 *
 * A hub URL as people say it out loud. The fallback branch is the load-
 * bearing one: `new URL()` throws on anything that is not a full URL, and a
 * hub can be typed as a bare host - so a card that showed nothing at all
 * for those would be the common local-network case, not an edge case.
 */

describe('hostOf', () => {
  it('drops the scheme and the path from a real URL', () => {
    expect(hostOf('https://matt.attack.fm/')).toBe('matt.attack.fm');
    expect(hostOf('http://matt.attack.fm/some/where')).toBe('matt.attack.fm');
  });

  it('keeps a port, which is how a hub on the local network is named', () => {
    expect(hostOf('http://192.168.1.20:8787')).toBe('192.168.1.20:8787');
  });

  it('falls back for a bare host that is not a URL at all', () => {
    // `new URL('matt.attack.fm')` throws; without the catch the card would
    // show nothing for a hub typed the way people actually type one.
    expect(hostOf('matt.attack.fm')).toBe('matt.attack.fm');
  });

  it('answers EMPTY for a bare host:port - a trap, not a supported input', () => {
    /*
     * `new URL('matt.attack.fm:8787')` does not throw: it parses
     * `matt.attack.fm:` as a SCHEME with an opaque path of `8787`, so the
     * catch never runs and `.host` is empty. The share card would show a
     * blank where the hub's name goes.
     *
     * Not a live bug: every caller passes `session.url`, and
     * `normalizeServerUrl` has already put `https://` on the front of
     * anything typed bare. Pinned because the fallback branch reads as
     * "handles a bare host", and this is the bare host it does not handle -
     * so anyone who starts feeding hostOf raw user input finds out here
     * rather than on a share card.
     */
    expect(hostOf('matt.attack.fm:8787')).toBe('');
    // What the app actually hands it, for contrast.
    expect(hostOf('https://matt.attack.fm:8787')).toBe('matt.attack.fm:8787');
  });

  it('strips the scheme in the fallback too', () => {
    expect(hostOf('https://')).toBe('');
  });

  it('gives an empty string back rather than throwing', () => {
    expect(hostOf('')).toBe('');
  });
});
